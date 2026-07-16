import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createDb } from '../db/client'
import { api_keys } from '../db/schema'
import type { AppBindings } from '../env'
import { formatApiKey, generateApiKeySecret } from '../lib/apikeys'
import { writeAudited } from '../lib/audit'
import { sha256Hex } from '../lib/crypto'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const apikeys = new Hono<AppBindings>()

// Machine-credential management is admin+.
apikeys.use('*', authenticate, authorize({ capability: 'apikeys.manage' }))

// Scopes a key may be granted. Kept in sync with the machine-callable routes.
const API_SCOPES = ['runs:write', 'runs:read', 'reports:read', 'flows:read'] as const

interface KeyRow {
  id: string
  name: string
  scopes: string
  project_scope: string | null
  expires_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
  created_by: string
}

function toDto(row: KeyRow) {
  return {
    id: row.id,
    name: row.name,
    scopes: JSON.parse(row.scopes) as string[],
    projectScope: row.project_scope ? (JSON.parse(row.project_scope) as string[]) : null,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    // Give the UI a hint without ever exposing the secret.
    keyPrefix: `charlie_…_${row.id.slice(0, 8)}`,
  }
}

// The column set returned to clients — mirrors KeyRow (secret_hash excluded).
const KEY_COLS = {
  id: api_keys.id,
  name: api_keys.name,
  scopes: api_keys.scopes,
  project_scope: api_keys.project_scope,
  expires_at: api_keys.expires_at,
  last_used_at: api_keys.last_used_at,
  revoked_at: api_keys.revoked_at,
  created_at: api_keys.created_at,
  created_by: api_keys.created_by,
}

// --- GET /api/api-keys ------------------------------------------------------
apikeys.get('/', async (c) => {
  const { orgId } = c.get('auth')
  const db = createDb(c.env.DB)
  const rows = await db
    .select(KEY_COLS)
    .from(api_keys)
    .where(eq(api_keys.org_id, orgId))
    .orderBy(desc(api_keys.created_at))
  return c.json({ apiKeys: rows.map(toDto) })
})

const createSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  projectScope: z.array(z.string()).nullish(),
  expiresAt: z.iso.datetime().nullish(),
})

// --- POST /api/api-keys — create; plaintext returned exactly once -----------
apikeys.post('/', async (c) => {
  const actor = c.get('auth')
  const body = await parseBody(c, createSchema)
  const db = createDb(c.env.DB)

  const keyId = uuidv7()
  const secret = generateApiKeySecret()
  const secretHash = await sha256Hex(secret)
  const envLabel = c.env.APP_BASE_URL.includes('localhost') ? 'test' : 'live'
  const token = formatApiKey(envLabel, keyId, secret)
  const scopesJson = JSON.stringify(body.scopes)
  const projectScopeJson = body.projectScope ? JSON.stringify(body.projectScope) : null
  const now = new Date().toISOString()

  await writeAudited(
    db,
    [
      db.insert(api_keys).values({
        id: keyId,
        org_id: actor.orgId,
        name: body.name,
        secret_hash: secretHash,
        scopes: scopesJson,
        project_scope: projectScopeJson,
        expires_at: body.expiresAt ?? null,
        created_by: actor.actorId,
        created_at: now,
      }),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'apikey.create',
      entityType: 'api_key',
      entityId: keyId,
      after: { name: body.name, scopes: body.scopes, projectScope: body.projectScope ?? null },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  // `token` is returned ONCE and never stored in plaintext.
  return c.json(
    {
      id: keyId,
      name: body.name,
      token,
      scopes: body.scopes,
      projectScope: body.projectScope ?? null,
      expiresAt: body.expiresAt ?? null,
      createdAt: now,
    },
    201,
  )
})

// --- DELETE /api/api-keys/:id — revoke --------------------------------------
apikeys.delete('/:id', async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const db = createDb(c.env.DB)

  const row = await db
    .select({ id: api_keys.id, name: api_keys.name, revoked_at: api_keys.revoked_at })
    .from(api_keys)
    .where(and(eq(api_keys.id, id), eq(api_keys.org_id, actor.orgId)))
    .get()
  if (!row) throw new HttpError('not_found', 'API key not found')
  if (row.revoked_at) return c.json({ ok: true }) // already revoked

  const now = new Date().toISOString()
  await writeAudited(
    db,
    [db.update(api_keys).set({ revoked_at: now }).where(eq(api_keys.id, id))],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'apikey.revoke',
      entityType: 'api_key',
      entityId: id,
      before: { name: row.name, revoked: false },
      after: { revoked: true },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  return c.json({ ok: true })
})

export default apikeys
