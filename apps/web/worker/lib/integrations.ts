// Connected-app credential storage. Config (tokens, signing secrets) is stored
// as AES-GCM ciphertext of a JSON blob, encrypted with CHARLIE_KEK — the same
// at-rest scheme as environment secrets, and likewise never returned to a
// client (routes expose only presence + non-secret hints).

import type { Env } from '../env'
import { decryptString, encryptString } from './crypto'
import { uuidv7 } from './ids'

export type IntegrationKind = 'slack' | 'github'

export interface SlackConfig {
  teamId?: string
  botToken: string
  signingSecret: string
}

interface IntegrationRow {
  id: string
  external_id: string | null
  config_ciphertext: string
}

/** Load and decrypt an integration's config, or null if not connected. */
export async function getIntegrationConfig<T = SlackConfig>(
  env: Env,
  orgId: string,
  kind: IntegrationKind,
): Promise<T | null> {
  const row = await env.DB.prepare(
    `SELECT id, external_id, config_ciphertext FROM integrations WHERE org_id = ? AND kind = ?`,
  )
    .bind(orgId, kind)
    .first<IntegrationRow>()
  if (!row) return null
  const json = await decryptString(row.config_ciphertext, env.CHARLIE_KEK ?? '')
  return JSON.parse(json) as T
}

/**
 * Resolve the Slack integration for an inbound request. Single-org self-host has
 * one Slack integration, so we match by team id when we have one and otherwise
 * fall back to the sole connected integration. Returns the org id + decrypted
 * config (the signing secret is what authenticates the request).
 */
export async function resolveSlackIntegration(
  env: Env,
  teamId: string | null,
): Promise<{ orgId: string; config: SlackConfig } | null> {
  const row = await env.DB.prepare(
    `SELECT org_id, config_ciphertext FROM integrations
       WHERE kind = 'slack' AND (external_id = ? OR external_id IS NULL OR ? IS NULL)
       ORDER BY (external_id = ?) DESC LIMIT 1`,
  )
    .bind(teamId, teamId, teamId)
    .first<{ org_id: string; config_ciphertext: string }>()
  if (!row) return null
  const config = JSON.parse(
    await decryptString(row.config_ciphertext, env.CHARLIE_KEK ?? ''),
  ) as SlackConfig
  return { orgId: row.org_id, config }
}

/** Whether an integration of this kind is connected (no decryption). */
export async function integrationStatus(
  env: Env,
  orgId: string,
  kind: IntegrationKind,
): Promise<{ connected: boolean; externalId: string | null; updatedAt: string | null }> {
  const row = await env.DB.prepare(
    `SELECT external_id, updated_at FROM integrations WHERE org_id = ? AND kind = ?`,
  )
    .bind(orgId, kind)
    .first<{ external_id: string | null; updated_at: string }>()
  return {
    connected: !!row,
    externalId: row?.external_id ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

/** Upsert an integration's encrypted config (one per org+kind). Returns a
 *  prepared statement so the caller can commit it with an audit row. */
export async function upsertIntegrationStatement(
  env: Env,
  params: {
    orgId: string
    kind: IntegrationKind
    externalId: string | null
    config: unknown
    createdBy: string | null
  },
): Promise<D1PreparedStatement> {
  const ciphertext = await encryptString(JSON.stringify(params.config), env.CHARLIE_KEK ?? '')
  const now = new Date().toISOString()
  return env.DB.prepare(
    `INSERT INTO integrations (id, org_id, kind, external_id, config_ciphertext, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, kind) DO UPDATE SET
       external_id = excluded.external_id,
       config_ciphertext = excluded.config_ciphertext,
       updated_at = excluded.updated_at`,
  ).bind(
    uuidv7(),
    params.orgId,
    params.kind,
    params.externalId,
    ciphertext,
    params.createdBy,
    now,
    now,
  )
}

/** Delete statement for disconnecting an integration. */
export function deleteIntegrationStatement(
  env: Env,
  orgId: string,
  kind: IntegrationKind,
): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM integrations WHERE org_id = ? AND kind = ?`).bind(orgId, kind)
}
