import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createDb, type Db } from '../db/client'
import { environments, projects } from '../db/schema'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { slugify } from '../lib/slug'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const projectsRoute = new Hono<AppBindings>()

projectsRoute.use('*', authenticate)

interface ProjectRow {
  id: string
  name: string
  slug: string
  description: string | null
  source_repo: string | null
  default_environment_id: string | null
  slack_channel: string | null
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
    slackChannel: row.slack_channel,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// The column set returned to clients — mirrors ProjectRow (secrets/soft-delete
// columns are intentionally excluded).
const PROJECT_COLS = {
  id: projects.id,
  name: projects.name,
  slug: projects.slug,
  description: projects.description,
  source_repo: projects.source_repo,
  default_environment_id: projects.default_environment_id,
  slack_channel: projects.slack_channel,
  created_by: projects.created_by,
  created_at: projects.created_at,
  updated_at: projects.updated_at,
}

async function loadProject(db: Db, orgId: string, id: string): Promise<ProjectRow> {
  const row = await db
    .select(PROJECT_COLS)
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.org_id, orgId), isNull(projects.deleted_at)))
    .get()
  if (!row) throw new HttpError('not_found', 'Project not found')
  return row
}

async function uniqueSlug(db: Db, orgId: string, base: string): Promise<string> {
  const root = base || 'project'
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`
    const clash = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.org_id, orgId), eq(projects.slug, candidate), isNull(projects.deleted_at)),
      )
      .limit(1)
      .get()
    if (!clash) return candidate
  }
  return `${root}-${uuidv7().slice(0, 8)}`
}

// --- GET /api/projects (viewer) ---------------------------------------------
projectsRoute.get('/', authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const db = createDb(c.env.DB)
  const rows = await db
    .select(PROJECT_COLS)
    .from(projects)
    .where(and(eq(projects.org_id, orgId), isNull(projects.deleted_at)))
    .orderBy(desc(projects.created_at))
  return c.json({ projects: rows.map(toDto) })
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
projectsRoute.post('/', authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  const body = await parseBody(c, createSchema)
  const slug = await uniqueSlug(db, actor.orgId, slugify(body.slug ?? body.name))
  const id = uuidv7()
  const now = new Date().toISOString()

  await writeAudited(
    db,
    [
      db.insert(projects).values({
        id,
        org_id: actor.orgId,
        name: body.name,
        slug,
        description: body.description ?? null,
        source_repo: body.sourceRepo ?? null,
        created_by: actor.actorId,
        created_at: now,
        updated_at: now,
      }),
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

  const row = await loadProject(db, actor.orgId, id)
  return c.json({ project: toDto(row) }, 201)
})

// --- GET /api/projects/:id (viewer) -----------------------------------------
projectsRoute.get('/:id', authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const db = createDb(c.env.DB)
  const row = await loadProject(db, orgId, c.req.param('id'))
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
    slackChannel: z.string().max(80).nullish(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no fields to update' })

// --- PATCH /api/projects/:id (editor) ---------------------------------------
projectsRoute.patch('/:id', authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const body = await parseBody(c, patchSchema)
  const before = await loadProject(db, actor.orgId, id)

  // If a default environment is named, it must belong to this project.
  if (body.defaultEnvironmentId) {
    const env = await db
      .select({ id: environments.id })
      .from(environments)
      .where(
        and(
          eq(environments.id, body.defaultEnvironmentId),
          eq(environments.project_id, id),
          isNull(environments.deleted_at),
        ),
      )
      .get()
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
    slack_channel: body.slackChannel === undefined ? before.slack_channel : body.slackChannel,
  }

  await writeAudited(
    db,
    [
      db
        .update(projects)
        .set({
          name: next.name,
          description: next.description,
          source_repo: next.source_repo,
          default_environment_id: next.default_environment_id,
          slack_channel: next.slack_channel,
          updated_at: now,
        })
        .where(eq(projects.id, id)),
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

  const row = await loadProject(db, actor.orgId, id)
  return c.json({ project: toDto(row) })
})

// --- DELETE /api/projects/:id (admin) — soft delete -------------------------
projectsRoute.delete('/:id', authorize({ capability: 'projects.delete' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const before = await loadProject(db, actor.orgId, id)
  const now = new Date().toISOString()

  await writeAudited(
    db,
    [db.update(projects).set({ deleted_at: now, updated_at: now }).where(eq(projects.id, id))],
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

export default projectsRoute
export { loadProject }
