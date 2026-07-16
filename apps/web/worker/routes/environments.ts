import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { roleHasCapability } from '../../shared/roles'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { applySecretPatch, decryptSecrets, encryptSecrets, maskedSecrets } from '../lib/secrets'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const environments = new Hono<AppBindings>()

environments.use('*', authenticate)

interface EnvRow {
  id: string
  project_id: string
  name: string
  base_url: string
  headers: string
  secrets_ciphertext: string | null
  auth_config: string | null
  created_at: string
  updated_at: string
}

async function toDto(row: EnvRow, kek: string | undefined) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    baseUrl: row.base_url,
    headers: JSON.parse(row.headers) as Record<string, string>,
    // Never plaintext — names present, values masked.
    secrets: await maskedSecrets(row.secrets_ciphertext, kek),
    authConfig: row.auth_config ? (JSON.parse(row.auth_config) as unknown) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const ENV_COLS =
  'id, project_id, name, base_url, headers, secrets_ciphertext, auth_config, created_at, updated_at'

async function assertProject(db: D1Database, orgId: string, projectId: string): Promise<void> {
  const row = await db
    .prepare(`SELECT 1 FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`)
    .bind(projectId, orgId)
    .first()
  if (!row) throw new HttpError('not_found', 'Project not found')
}

async function loadEnv(db: D1Database, orgId: string, id: string): Promise<EnvRow> {
  // Join to projects to enforce org ownership.
  const row = await db
    .prepare(
      `SELECT e.id, e.project_id, e.name, e.base_url, e.headers, e.secrets_ciphertext,
              e.auth_config, e.created_at, e.updated_at
         FROM environments e
         JOIN projects p ON p.id = e.project_id
        WHERE e.id = ? AND p.org_id = ? AND e.deleted_at IS NULL`,
    )
    .bind(id, orgId)
    .first<EnvRow>()
  if (!row) throw new HttpError('not_found', 'Environment not found')
  return row
}

/** Managing raw secret values requires admin (secrets.manage); editors cannot. */
function assertCanManageSecrets(c: Context<AppBindings>): void {
  const auth = c.get('auth')
  const ok =
    auth.actorKind === 'user' && auth.user && roleHasCapability(auth.user.role, 'secrets.manage')
  if (!ok) throw new HttpError('forbidden', 'Managing environment secrets requires admin')
}

const headersSchema = z.record(z.string(), z.string())

// --- GET /api/projects/:projectId/environments (viewer) ---------------------
environments.get(
  '/projects/:projectId/environments',
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const projectId = c.req.param('projectId')
    await assertProject(c.env.DB, orgId, projectId)
    const rows = await c.env.DB.prepare(
      `SELECT ${ENV_COLS} FROM environments
         WHERE project_id = ? AND deleted_at IS NULL ORDER BY name ASC`,
    )
      .bind(projectId)
      .all<EnvRow>()
    const dtos = await Promise.all(rows.results.map((r) => toDto(r, c.env.CHARLIE_KEK)))
    return c.json({ environments: dtos })
  },
)

const createSchema = z.object({
  name: z.string().min(1).max(60),
  baseUrl: z.string().url(),
  headers: headersSchema.optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  authConfig: z.unknown().optional(),
})

// --- POST /api/projects/:projectId/environments (editor; secrets → admin) ---
environments.post(
  '/projects/:projectId/environments',
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const projectId = c.req.param('projectId')
    await assertProject(c.env.DB, actor.orgId, projectId)
    const body = await parseBody(c, createSchema)

    if (body.secrets && Object.keys(body.secrets).length > 0) assertCanManageSecrets(c)

    const id = uuidv7()
    const now = new Date().toISOString()
    const ciphertext =
      body.secrets && Object.keys(body.secrets).length > 0
        ? await encryptSecrets(body.secrets, c.env.CHARLIE_KEK)
        : null

    await writeAudited(
      c.env.DB,
      [
        c.env.DB.prepare(
          `INSERT INTO environments
             (id, project_id, name, base_url, headers, secrets_ciphertext, auth_config,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          projectId,
          body.name,
          body.baseUrl,
          JSON.stringify(body.headers ?? {}),
          ciphertext,
          body.authConfig !== undefined ? JSON.stringify(body.authConfig) : null,
          now,
          now,
        ),
      ],
      {
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        action: 'environment.create',
        entityType: 'environment',
        entityId: id,
        // Values redacted by the audit layer; we record only names of secrets set.
        after: {
          name: body.name,
          baseUrl: body.baseUrl,
          secretNames: Object.keys(body.secrets ?? {}),
        },
        ip: clientIp(c),
        userAgent: userAgent(c),
      },
    )

    const row = await loadEnv(c.env.DB, actor.orgId, id)
    return c.json({ environment: await toDto(row, c.env.CHARLIE_KEK) }, 201)
  },
)

const patchSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    baseUrl: z.string().url().optional(),
    headers: headersSchema.optional(),
    // A patch map: value string sets, null deletes that secret.
    secrets: z.record(z.string(), z.string().nullable()).optional(),
    authConfig: z.unknown().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' })

// --- PATCH /api/environments/:id (editor; secrets → admin) ------------------
environments.patch('/environments/:id', authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const before = await loadEnv(c.env.DB, actor.orgId, id)
  const body = await parseBody(c, patchSchema)

  let ciphertext = before.secrets_ciphertext
  let secretNamesChanged: string[] | undefined
  if (body.secrets !== undefined) {
    assertCanManageSecrets(c)
    const existing = await decryptSecrets(before.secrets_ciphertext, c.env.CHARLIE_KEK)
    const next = applySecretPatch(existing, body.secrets)
    ciphertext = Object.keys(next).length > 0 ? await encryptSecrets(next, c.env.CHARLIE_KEK) : null
    secretNamesChanged = Object.keys(body.secrets)
  }

  const now = new Date().toISOString()
  const next = {
    name: body.name ?? before.name,
    base_url: body.baseUrl ?? before.base_url,
    headers: body.headers ? JSON.stringify(body.headers) : before.headers,
    auth_config:
      body.authConfig === undefined ? before.auth_config : JSON.stringify(body.authConfig),
  }

  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(
        `UPDATE environments SET name = ?, base_url = ?, headers = ?, secrets_ciphertext = ?,
                                 auth_config = ?, updated_at = ?
           WHERE id = ?`,
      ).bind(next.name, next.base_url, next.headers, ciphertext, next.auth_config, now, id),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'environment.update',
      entityType: 'environment',
      entityId: id,
      before: { name: before.name, baseUrl: before.base_url },
      after: { name: next.name, baseUrl: next.base_url, secretNamesChanged },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  const row = await loadEnv(c.env.DB, actor.orgId, id)
  return c.json({ environment: await toDto(row, c.env.CHARLIE_KEK) })
})

// --- DELETE /api/environments/:id (admin) -----------------------------------
environments.delete(
  '/environments/:id',
  authorize({ capability: 'projects.delete' }),
  async (c) => {
    const actor = c.get('auth')
    const id = c.req.param('id')
    const before = await loadEnv(c.env.DB, actor.orgId, id)
    const now = new Date().toISOString()

    await writeAudited(
      c.env.DB,
      [
        c.env.DB.prepare(
          `UPDATE environments SET deleted_at = ?, updated_at = ? WHERE id = ?`,
        ).bind(now, now, id),
      ],
      {
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        action: 'environment.delete',
        entityType: 'environment',
        entityId: id,
        before: { name: before.name },
        after: null,
        ip: clientIp(c),
        userAgent: userAgent(c),
      },
    )

    return c.json({ ok: true })
  },
)

export default environments
