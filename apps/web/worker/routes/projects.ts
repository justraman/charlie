import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { slugify } from '../lib/slug'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const projects = new Hono<AppBindings>()

projects.use('*', authenticate)

interface ProjectRow {
  id: string
  name: string
  slug: string
  description: string | null
  source_repo: string | null
  default_environment_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

function toDto(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    sourceRepo: row.source_repo,
    defaultEnvironmentId: row.default_environment_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const PROJECT_COLS =
  'id, name, slug, description, source_repo, default_environment_id, created_by, created_at, updated_at'

async function loadProject(db: D1Database, orgId: string, id: string): Promise<ProjectRow> {
  const row = await db
    .prepare(
      `SELECT ${PROJECT_COLS} FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    )
    .bind(id, orgId)
    .first<ProjectRow>()
  if (!row) throw new HttpError('not_found', 'Project not found')
  return row
}

async function uniqueSlug(db: D1Database, orgId: string, base: string): Promise<string> {
  const root = base || 'project'
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`
    const clash = await db
      .prepare(
        `SELECT 1 FROM projects WHERE org_id = ? AND slug = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .bind(orgId, candidate)
      .first()
    if (!clash) return candidate
  }
  return `${root}-${uuidv7().slice(0, 8)}`
}

// --- GET /api/projects (viewer) ---------------------------------------------
projects.get('/', authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const rows = await c.env.DB.prepare(
    `SELECT ${PROJECT_COLS} FROM projects
       WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
  )
    .bind(orgId)
    .all<ProjectRow>()
  return c.json({ projects: rows.results.map(toDto) })
})

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(60).optional(),
  description: z.string().max(2000).nullish(),
  sourceRepo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"')
    .nullish(),
})

// --- POST /api/projects (editor) --------------------------------------------
projects.post('/', authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const body = await parseBody(c, createSchema)
  const slug = await uniqueSlug(c.env.DB, actor.orgId, slugify(body.slug ?? body.name))
  const id = uuidv7()
  const now = new Date().toISOString()

  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(
        `INSERT INTO projects
           (id, org_id, name, slug, description, source_repo, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        actor.orgId,
        body.name,
        slug,
        body.description ?? null,
        body.sourceRepo ?? null,
        actor.actorId,
        now,
        now,
      ),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'project.create',
      entityType: 'project',
      entityId: id,
      after: { name: body.name, slug, sourceRepo: body.sourceRepo ?? null },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  const row = await loadProject(c.env.DB, actor.orgId, id)
  return c.json({ project: toDto(row) }, 201)
})

// --- GET /api/projects/:id (viewer) -----------------------------------------
projects.get('/:id', authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const row = await loadProject(c.env.DB, orgId, c.req.param('id'))
  return c.json({ project: toDto(row) })
})

const patchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullish(),
    sourceRepo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'must be "owner/repo"')
      .nullish(),
    defaultEnvironmentId: z.string().nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' })

// --- PATCH /api/projects/:id (editor) ---------------------------------------
projects.patch('/:id', authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const body = await parseBody(c, patchSchema)
  const before = await loadProject(c.env.DB, actor.orgId, id)

  // If a default environment is named, it must belong to this project.
  if (body.defaultEnvironmentId) {
    const env = await c.env.DB.prepare(
      `SELECT 1 FROM environments WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
    )
      .bind(body.defaultEnvironmentId, id)
      .first()
    if (!env)
      throw new HttpError(
        'bad_request',
        'defaultEnvironmentId is not an environment of this project',
      )
  }

  const now = new Date().toISOString()
  const next = {
    name: body.name ?? before.name,
    description: body.description === undefined ? before.description : body.description,
    source_repo: body.sourceRepo === undefined ? before.source_repo : body.sourceRepo,
    default_environment_id:
      body.defaultEnvironmentId === undefined
        ? before.default_environment_id
        : body.defaultEnvironmentId,
  }

  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(
        `UPDATE projects SET name = ?, description = ?, source_repo = ?,
                             default_environment_id = ?, updated_at = ?
           WHERE id = ?`,
      ).bind(next.name, next.description, next.source_repo, next.default_environment_id, now, id),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'project.update',
      entityType: 'project',
      entityId: id,
      before: {
        name: before.name,
        description: before.description,
        sourceRepo: before.source_repo,
      },
      after: { name: next.name, description: next.description, sourceRepo: next.source_repo },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  const row = await loadProject(c.env.DB, actor.orgId, id)
  return c.json({ project: toDto(row) })
})

// --- DELETE /api/projects/:id (admin) — soft delete -------------------------
projects.delete('/:id', authorize({ capability: 'projects.delete' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const before = await loadProject(c.env.DB, actor.orgId, id)
  const now = new Date().toISOString()

  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(`UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?`).bind(
        now,
        now,
        id,
      ),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'project.delete',
      entityType: 'project',
      entityId: id,
      before: { name: before.name, slug: before.slug },
      after: null,
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  return c.json({ ok: true })
})

export default projects
export { loadProject }
