// Connected-app credential storage. Config (tokens, signing secrets) is stored
// as AES-GCM ciphertext of a JSON blob, encrypted with CHARLIE_KEK — the same
// at-rest scheme as environment secrets, and likewise never returned to a
// client (routes expose only presence + non-secret hints).

import { and, eq, sql } from 'drizzle-orm'
import { createDb, type Db } from '../db/client'
import { integrations } from '../db/schema'
import type { Env } from '../env'
import type { Mutation } from './audit'
import { decryptString, encryptString } from './crypto'
import { uuidv7 } from './ids'

export type IntegrationKind = 'slack' | 'github'

export interface SlackConfig {
  teamId?: string
  botToken: string
  signingSecret: string
}

/** Load and decrypt an integration's config, or null if not connected. */
export async function getIntegrationConfig<T = SlackConfig>(
  env: Env,
  orgId: string,
  kind: IntegrationKind,
): Promise<T | null> {
  const db = createDb(env.DB)
  const row = await db
    .select({ config_ciphertext: integrations.config_ciphertext })
    .from(integrations)
    .where(and(eq(integrations.org_id, orgId), eq(integrations.kind, kind)))
    .get()
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
  const db = createDb(env.DB)
  const row = await db
    .select({
      org_id: integrations.org_id,
      config_ciphertext: integrations.config_ciphertext,
    })
    .from(integrations)
    // Prefer an exact team-id match, but a single-org self-host may have stored
    // the integration with no external_id, and inbound requests may lack one.
    .where(
      sql`${integrations.kind} = 'slack' and (${integrations.external_id} = ${teamId} or ${integrations.external_id} is null or ${teamId} is null)`,
    )
    .orderBy(sql`(${integrations.external_id} = ${teamId}) desc`)
    .limit(1)
    .get()
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
  const db = createDb(env.DB)
  const row = await db
    .select({ external_id: integrations.external_id, updated_at: integrations.updated_at })
    .from(integrations)
    .where(and(eq(integrations.org_id, orgId), eq(integrations.kind, kind)))
    .get()
  return {
    connected: !!row,
    externalId: row?.external_id ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

/** Encrypt an integration's config JSON with CHARLIE_KEK (async, so it runs
 *  before building the — necessarily synchronous — upsert statement). */
export function encryptIntegrationConfig(env: Env, config: unknown): Promise<string> {
  return encryptString(JSON.stringify(config), env.CHARLIE_KEK ?? '')
}

/**
 * Upsert an integration's encrypted config (one per org+kind). Returns an
 * unexecuted Drizzle statement so the caller can commit it in one batch with an
 * audit row. Synchronous by contract: a Drizzle builder is a thenable, so
 * returning one from an `async` function would execute it immediately — hence
 * the ciphertext is computed by the caller via `encryptIntegrationConfig`.
 */
export function upsertIntegrationStatement(
  db: Db,
  params: {
    orgId: string
    kind: IntegrationKind
    externalId: string | null
    configCiphertext: string
    createdBy: string | null
  },
): Mutation {
  const now = new Date().toISOString()
  return db
    .insert(integrations)
    .values({
      id: uuidv7(),
      org_id: params.orgId,
      kind: params.kind,
      external_id: params.externalId,
      config_ciphertext: params.configCiphertext,
      created_by: params.createdBy,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [integrations.org_id, integrations.kind],
      set: {
        external_id: sql`excluded.external_id`,
        config_ciphertext: sql`excluded.config_ciphertext`,
        updated_at: sql`excluded.updated_at`,
      },
    })
}

/** Delete statement for disconnecting an integration. */
export function deleteIntegrationStatement(db: Db, orgId: string, kind: IntegrationKind): Mutation {
  return db
    .delete(integrations)
    .where(and(eq(integrations.org_id, orgId), eq(integrations.kind, kind)))
}
