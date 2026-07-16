// Connected-app management (admin). Slack is a single-workspace app: an admin
// pastes the bot token + signing secret (and optional team id) from the Slack
// app config; they are stored encrypted and never returned. GitHub App status
// is derived from Worker secrets (configured at deploy), so it is read-only here.

import { Hono } from 'hono'
import { z } from 'zod'
import { createDb } from '../db/client'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { githubConfigured } from '../lib/github'
import { clientIp, HttpError, userAgent } from '../lib/http'
import {
  deleteIntegrationStatement,
  encryptIntegrationConfig,
  integrationStatus,
  upsertIntegrationStatement,
} from '../lib/integrations'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const integrations = new Hono<AppBindings>()

integrations.use('*', authenticate)

// --- GET /api/integrations — connection status (no secrets) -----------------
integrations.get('/', authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const slack = await integrationStatus(c.env, orgId, 'slack')
  return c.json({
    slack: { connected: slack.connected, teamId: slack.externalId, updatedAt: slack.updatedAt },
    // The GitHub App is configured via Worker secrets, not this table.
    github: { connected: githubConfigured(c.env) },
  })
})

const slackConnectSchema = z.object({
  teamId: z.string().max(64).optional(),
  botToken: z.string().min(10),
  signingSecret: z.string().min(10),
})

// --- PUT /api/integrations/slack — connect / update -------------------------
integrations.put('/slack', authorize({ capability: 'integrations.manage' }), async (c) => {
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  const body = await parseBody(c, slackConnectSchema)

  const configCiphertext = await encryptIntegrationConfig(c.env, {
    teamId: body.teamId,
    botToken: body.botToken,
    signingSecret: body.signingSecret,
  })
  const stmt = upsertIntegrationStatement(db, {
    orgId: actor.orgId,
    kind: 'slack',
    externalId: body.teamId ?? null,
    configCiphertext,
    createdBy: actor.actorId,
  })

  await writeAudited(db, [stmt], {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'integration.connect',
    entityType: 'integration',
    entityId: 'slack',
    // Secrets are redacted by key-name in the audit layer; record only presence.
    after: { kind: 'slack', teamId: body.teamId ?? null, botToken: '***', signingSecret: '***' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  })

  const status = await integrationStatus(c.env, actor.orgId, 'slack')
  return c.json({ slack: { connected: status.connected, teamId: status.externalId } })
})

// --- DELETE /api/integrations/slack — disconnect ----------------------------
integrations.delete('/slack', authorize({ capability: 'integrations.manage' }), async (c) => {
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  const existing = await integrationStatus(c.env, actor.orgId, 'slack')
  if (!existing.connected) throw new HttpError('not_found', 'Slack is not connected')

  await writeAudited(db, [deleteIntegrationStatement(db, actor.orgId, 'slack')], {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'integration.disconnect',
    entityType: 'integration',
    entityId: 'slack',
    before: { kind: 'slack', teamId: existing.externalId },
    after: null,
    ip: clientIp(c),
    userAgent: userAgent(c),
  })
  return c.json({ ok: true })
})

export default integrations
