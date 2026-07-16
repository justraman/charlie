import { and, asc, eq, isNull } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { roleHasCapability } from '../../shared/roles'
import { createDb, type Db } from '../db/client'
import { environments as environmentsTable, projects } from '../db/schema'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { applySecretPatch, decryptSecrets, encryptSecrets, maskedSecrets } from '../lib/secrets'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const environments = new Hono<AppBindings>()

// Mounted at the API root, so no blanket `use('*')` (it would shadow run-token
// callback routes). Each route attaches `authenticate` explicitly.

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

// The column set loaded for an environment. `secrets_ciphertext` is included so
// the DTO layer can surface secret *names* (masked) — it is never returned raw.
const ENV_COLS = {
  id: environmentsTable.id,
  project_id: environmentsTable.project_id,
  name: environmentsTable.name,
  base_url: environmentsTable.base_url,
  headers: environmentsTable.headers,
  secrets_ciphertext: environmentsTable.secrets_ciphertext,
  auth_config: environmentsTable.auth_config,
  created_at: environmentsTable.created_at,
  updated_at: environmentsTable.updated_at,
}

async function assertProject(db: Db, orgId: string, projectId: string): Promise<void> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId), isNull(projects.deleted_at)))
    .get()
  if (!row) throw new HttpError('not_found', 'Project not found')
}

async function loadEnv(db: Db, orgId: string, id: string): Promise<EnvRow> {
  // Join to projects to enforce org ownership.
  const row = await db
    .select(ENV_COLS)
    .from(environmentsTable)
    .innerJoin(projects, eq(projects.id, environmentsTable.project_id))
    .where(
      and(
        eq(environmentsTable.id, id),
        eq(projects.org_id, orgId),
        isNull(environmentsTable.deleted_at),
      ),
    )
    .get()
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
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const projectId = c.req.param('projectId')
    const db = createDb(c.env.DB)
    await assertProject(db, orgId, projectId)
    const rows = await db
      .select(ENV_COLS)
      .from(environmentsTable)
      .where(and(eq(environmentsTable.project_id, projectId), isNull(environmentsTable.deleted_at)))
      .orderBy(asc(environmentsTable.name))
    const dtos = await Promise.all(rows.map((r) => toDto(r, c.env.CHARLIE_KEK)))
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
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const projectId = c.req.param('projectId')
    const db = createDb(c.env.DB)
    await assertProject(db, actor.orgId, projectId)
    const body = await parseBody(c, createSchema)

    if (body.secrets && Object.keys(body.secrets).length > 0) assertCanManageSecrets(c)

    const id = uuidv7()
    const now = new Date().toISOString()
    const ciphertext =
      body.secrets && Object.keys(body.secrets).length > 0
        ? await encryptSecrets(body.secrets, c.env.CHARLIE_KEK)
        : null

    await writeAudited(
      db,
      [
        db.insert(environmentsTable).values({
          id,
          project_id: projectId,
          name: body.name,
          base_url: body.baseUrl,
          headers: JSON.stringify(body.headers ?? {}),
          secrets_ciphertext: ciphertext,
          auth_config: body.authConfig !== undefined ? JSON.stringify(body.authConfig) : null,
          created_at: now,
          updated_at: now,
        }),
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

    const row = await loadEnv(db, actor.orgId, id)
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
environments.patch(
  '/environments/:id',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    const before = await loadEnv(db, actor.orgId, id)
    const body = await parseBody(c, patchSchema)

    let ciphertext = before.secrets_ciphertext
    let secretNamesChanged: string[] | undefined
    if (body.secrets !== undefined) {
      assertCanManageSecrets(c)
      const existing = await decryptSecrets(before.secrets_ciphertext, c.env.CHARLIE_KEK)
      const next = applySecretPatch(existing, body.secrets)
      ciphertext =
        Object.keys(next).length > 0 ? await encryptSecrets(next, c.env.CHARLIE_KEK) : null
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
      db,
      [
        db
          .update(environmentsTable)
          .set({
            name: next.name,
            base_url: next.base_url,
            headers: next.headers,
            secrets_ciphertext: ciphertext,
            auth_config: next.auth_config,
            updated_at: now,
          })
          .where(eq(environmentsTable.id, id)),
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

    const row = await loadEnv(db, actor.orgId, id)
    return c.json({ environment: await toDto(row, c.env.CHARLIE_KEK) })
  },
)

// --- DELETE /api/environments/:id (admin) -----------------------------------
environments.delete(
  '/environments/:id',
  authenticate,
  authorize({ capability: 'projects.delete' }),
  async (c) => {
    const actor = c.get('auth')
    const id = c.req.param('id')
    const db = createDb(c.env.DB)
    const before = await loadEnv(db, actor.orgId, id)
    const now = new Date().toISOString()

    await writeAudited(
      db,
      [
        db
          .update(environmentsTable)
          .set({ deleted_at: now, updated_at: now })
          .where(eq(environmentsTable.id, id)),
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
