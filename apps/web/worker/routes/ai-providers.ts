// AI provider configuration (admin). Bring-your-own-key: the provider name,
// model, and credentials are stored per org; the key is AES-GCM encrypted with
// CHARLIE_KEK and never returned to a client. The org's default provider is
// organization.default_ai_provider_id.

import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { encryptString } from '../lib/crypto'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const aiProviders = new Hono<AppBindings>()

aiProviders.use('*', authenticate)

interface ProviderRow {
  id: string
  name: string
  model: string
  api_key_ciphertext: string | null
  created_at: string
  updated_at: string
}

async function defaultProviderId(db: D1Database, orgId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT default_ai_provider_id FROM organization WHERE id = ?`)
    .bind(orgId)
    .first<{ default_ai_provider_id: string | null }>()
  return row?.default_ai_provider_id ?? null
}

function toDto(row: ProviderRow, defaultId: string | null) {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    hasKey: !!row.api_key_ciphertext,
    isDefault: row.id === defaultId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function loadProvider(db: D1Database, orgId: string, id: string): Promise<ProviderRow> {
  const row = await db
    .prepare(
      `SELECT id, name, model, api_key_ciphertext, created_at, updated_at
         FROM ai_providers WHERE id = ? AND org_id = ?`,
    )
    .bind(id, orgId)
    .first<ProviderRow>()
  if (!row) throw new HttpError('not_found', 'Provider not found')
  return row
}

// --- GET /api/ai-providers (viewer) — list, no secrets ----------------------
aiProviders.get('/', authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const defaultId = await defaultProviderId(c.env.DB, orgId)
  const rows = await c.env.DB.prepare(
    `SELECT id, name, model, api_key_ciphertext, created_at, updated_at
       FROM ai_providers WHERE org_id = ? ORDER BY created_at ASC`,
  )
    .bind(orgId)
    .all<ProviderRow>()
  return c.json({
    providers: rows.results.map((r) => toDto(r, defaultId)),
    defaultProviderId: defaultId,
  })
})

const createSchema = z.object({
  name: z.enum(['anthropic', 'openai', 'workers_ai']),
  model: z.string().min(1).max(120),
  apiKey: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(), // workers_ai
  makeDefault: z.boolean().optional(),
})

// --- POST /api/ai-providers (admin) — add -----------------------------------
aiProviders.post('/', authorize({ capability: 'integrations.manage' }), async (c) => {
  const actor = c.get('auth')
  const body = await parseBody(c, createSchema)
  // Non-Workers-AI providers require a key.
  if (body.name !== 'workers_ai' && !body.apiKey) {
    throw new HttpError('bad_request', `${body.name} requires an apiKey`)
  }
  const id = uuidv7()
  const now = new Date().toISOString()
  const ciphertext =
    body.apiKey || body.accountId
      ? await encryptString(
          JSON.stringify({ apiKey: body.apiKey ?? null, accountId: body.accountId ?? null }),
          c.env.CHARLIE_KEK ?? '',
        )
      : null

  const existingDefault = await defaultProviderId(c.env.DB, actor.orgId)
  const makeDefault = body.makeDefault || !existingDefault

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO ai_providers (id, org_id, name, model, api_key_ciphertext, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, actor.orgId, body.name, body.model, ciphertext, actor.actorId, now, now),
  ]
  if (makeDefault) {
    statements.push(
      c.env.DB.prepare(`UPDATE organization SET default_ai_provider_id = ? WHERE id = ?`).bind(
        id,
        actor.orgId,
      ),
    )
  }

  await writeAudited(c.env.DB, statements, {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'ai_provider.create',
    entityType: 'ai_provider',
    entityId: id,
    // apiKey/accountId redacted by the audit layer's key-name filter.
    after: { name: body.name, model: body.model, apiKey: '***', isDefault: makeDefault },
    ip: clientIp(c),
    userAgent: userAgent(c),
  })

  const row = await loadProvider(c.env.DB, actor.orgId, id)
  return c.json({ provider: toDto(row, makeDefault ? id : existingDefault) }, 201)
})

const patchSchema = z.object({
  model: z.string().min(1).max(120).optional(),
  apiKey: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  makeDefault: z.boolean().optional(),
})

// --- PATCH /api/ai-providers/:id (admin) ------------------------------------
aiProviders.patch('/:id', authorize({ capability: 'integrations.manage' }), async (c) => {
  const actor = c.get('auth')
  const existing = await loadProvider(c.env.DB, actor.orgId, c.req.param('id'))
  const body = await parseBody(c, patchSchema)
  const now = new Date().toISOString()

  const ciphertext =
    body.apiKey || body.accountId
      ? await encryptString(
          JSON.stringify({ apiKey: body.apiKey ?? null, accountId: body.accountId ?? null }),
          c.env.CHARLIE_KEK ?? '',
        )
      : existing.api_key_ciphertext

  const statements = [
    c.env.DB.prepare(
      `UPDATE ai_providers SET model = ?, api_key_ciphertext = ?, updated_at = ? WHERE id = ?`,
    ).bind(body.model ?? existing.model, ciphertext, now, existing.id),
  ]
  if (body.makeDefault) {
    statements.push(
      c.env.DB.prepare(`UPDATE organization SET default_ai_provider_id = ? WHERE id = ?`).bind(
        existing.id,
        actor.orgId,
      ),
    )
  }

  await writeAudited(c.env.DB, statements, {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'ai_provider.update',
    entityType: 'ai_provider',
    entityId: existing.id,
    after: { model: body.model ?? existing.model, keyChanged: !!body.apiKey },
    ip: clientIp(c),
    userAgent: userAgent(c),
  })

  const defaultId = await defaultProviderId(c.env.DB, actor.orgId)
  const row = await loadProvider(c.env.DB, actor.orgId, existing.id)
  return c.json({ provider: toDto(row, defaultId) })
})

// --- DELETE /api/ai-providers/:id (admin) -----------------------------------
aiProviders.delete('/:id', authorize({ capability: 'integrations.manage' }), async (c) => {
  const actor = c.get('auth')
  const existing = await loadProvider(c.env.DB, actor.orgId, c.req.param('id'))
  const wasDefault = (await defaultProviderId(c.env.DB, actor.orgId)) === existing.id

  const statements = [c.env.DB.prepare(`DELETE FROM ai_providers WHERE id = ?`).bind(existing.id)]
  if (wasDefault) {
    statements.push(
      c.env.DB.prepare(`UPDATE organization SET default_ai_provider_id = NULL WHERE id = ?`).bind(
        actor.orgId,
      ),
    )
  }

  await writeAudited(c.env.DB, statements, {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'ai_provider.delete',
    entityType: 'ai_provider',
    entityId: existing.id,
    before: { name: existing.name, model: existing.model },
    after: null,
    ip: clientIp(c),
    userAgent: userAgent(c),
  })

  return c.json({ ok: true })
})

export default aiProviders
