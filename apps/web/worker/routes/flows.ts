import {
  ENGINES,
  type FlowBody,
  flowBodySchema,
  flowDefinitionSchema,
  loadProfileSchema,
  summarizeFlowDiff,
} from '@charlie/flow-core'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const flows = new Hono<AppBindings>()

// Mounted at the API root, so no blanket `use('*')` (it would shadow run-token
// callback routes). Each route attaches `authenticate` explicitly.

interface FlowRow {
  id: string
  project_id: string
  name: string
  description: string | null
  current_version_id: string | null
  engines: string
  origin: string
  created_by: string
  created_at: string
  updated_at: string
}

interface VersionRow {
  id: string
  flow_id: string
  version: number
  steps: string
  load_profile: string | null
  author_id: string
  diff_summary: string | null
  created_at: string
}

function flowDto(row: FlowRow, currentVersion: number | null) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    engines: JSON.parse(row.engines) as string[],
    origin: row.origin,
    currentVersion,
    currentVersionId: row.current_version_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function versionDto(row: VersionRow) {
  return {
    id: row.id,
    flowId: row.flow_id,
    version: row.version,
    steps: JSON.parse(row.steps),
    loadProfile: row.load_profile ? JSON.parse(row.load_profile) : null,
    authorId: row.author_id,
    diffSummary: row.diff_summary,
    createdAt: row.created_at,
  }
}

async function assertProject(db: D1Database, orgId: string, projectId: string): Promise<void> {
  const row = await db
    .prepare(`SELECT 1 FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`)
    .bind(projectId, orgId)
    .first()
  if (!row) throw new HttpError('not_found', 'Project not found')
}

async function loadFlow(db: D1Database, orgId: string, id: string): Promise<FlowRow> {
  const row = await db
    .prepare(
      `SELECT f.id, f.project_id, f.name, f.description, f.current_version_id, f.engines,
              f.origin, f.created_by, f.created_at, f.updated_at
         FROM flows f
         JOIN projects p ON p.id = f.project_id
        WHERE f.id = ? AND p.org_id = ? AND f.deleted_at IS NULL`,
    )
    .bind(id, orgId)
    .first<FlowRow>()
  if (!row) throw new HttpError('not_found', 'Flow not found')
  return row
}

async function loadVersion(db: D1Database, flowId: string, versionId: string): Promise<VersionRow> {
  const row = await db
    .prepare(`SELECT * FROM flow_versions WHERE id = ? AND flow_id = ?`)
    .bind(versionId, flowId)
    .first<VersionRow>()
  if (!row) throw new HttpError('not_found', 'Version not found')
  return row
}

// --- GET /api/projects/:projectId/flows (viewer) ----------------------------
flows.get(
  '/projects/:projectId/flows',
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const projectId = c.req.param('projectId')
    await assertProject(c.env.DB, orgId, projectId)
    const rows = await c.env.DB.prepare(
      `SELECT f.id, f.project_id, f.name, f.description, f.current_version_id, f.engines,
            f.origin, f.created_by, f.created_at, f.updated_at, v.version AS current_version
       FROM flows f
       LEFT JOIN flow_versions v ON v.id = f.current_version_id
      WHERE f.project_id = ? AND f.deleted_at IS NULL ORDER BY f.name ASC`,
    )
      .bind(projectId)
      .all<FlowRow & { current_version: number | null }>()
    return c.json({
      flows: rows.results.map((r) => flowDto(r, r.current_version)),
    })
  },
)

const createSchema = flowDefinitionSchema

// --- POST /api/projects/:projectId/flows (editor) — create flow + v1 --------
flows.post(
  '/projects/:projectId/flows',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const projectId = c.req.param('projectId')
    await assertProject(c.env.DB, actor.orgId, projectId)
    const body = await parseBody(c, createSchema)

    const clash = await c.env.DB.prepare(
      `SELECT 1 FROM flows WHERE project_id = ? AND name = ? AND deleted_at IS NULL`,
    )
      .bind(projectId, body.name)
      .first()
    if (clash) throw new HttpError('conflict', `A flow named "${body.name}" already exists`)

    const flowId = uuidv7()
    const versionId = uuidv7()
    const now = new Date().toISOString()
    const flowBody: FlowBody = { steps: body.steps, loadProfile: body.loadProfile ?? null }
    const diff = summarizeFlowDiff(null, flowBody)

    await writeAudited(
      c.env.DB,
      [
        // FK-safe ordering: flow (no current version) → version → point flow at it.
        c.env.DB.prepare(
          `INSERT INTO flows
           (id, project_id, name, description, current_version_id, engines, origin,
            created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, 'manual', ?, ?, ?)`,
        ).bind(
          flowId,
          projectId,
          body.name,
          body.description ?? null,
          JSON.stringify(body.engines),
          actor.actorId,
          now,
          now,
        ),
        c.env.DB.prepare(
          `INSERT INTO flow_versions
           (id, flow_id, version, steps, load_profile, author_id, diff_summary, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
        ).bind(
          versionId,
          flowId,
          JSON.stringify(body.steps),
          body.loadProfile ? JSON.stringify(body.loadProfile) : null,
          actor.actorId,
          diff,
          now,
        ),
        c.env.DB.prepare(`UPDATE flows SET current_version_id = ? WHERE id = ?`).bind(
          versionId,
          flowId,
        ),
      ],
      {
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        action: 'flow.create',
        entityType: 'flow',
        entityId: flowId,
        after: { name: body.name, engines: body.engines, version: 1 },
        ip: clientIp(c),
        userAgent: userAgent(c),
      },
    )

    const row = await loadFlow(c.env.DB, actor.orgId, flowId)
    return c.json({ flow: flowDto(row, 1) }, 201)
  },
)

// --- GET /api/flows/:id (viewer) — flow + current version -------------------
flows.get('/flows/:id', authenticate, authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const row = await loadFlow(c.env.DB, orgId, c.req.param('id'))
  const version = row.current_version_id
    ? await loadVersion(c.env.DB, row.id, row.current_version_id)
    : null
  return c.json({
    flow: flowDto(row, version?.version ?? null),
    currentVersion: version ? versionDto(version) : null,
  })
})

const putSchema = flowBodySchema.extend({
  description: z.string().max(2000).nullish(),
  engines: z.array(z.enum(ENGINES)).min(1).optional(),
  loadProfile: loadProfileSchema.nullish(),
})

// --- PUT /api/flows/:id (editor) — new version + diff -----------------------
flows.put('/flows/:id', authenticate, authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const flow = await loadFlow(c.env.DB, actor.orgId, id)
  const body = await parseBody(c, putSchema)

  const current = flow.current_version_id
    ? await loadVersion(c.env.DB, flow.id, flow.current_version_id)
    : null
  const prevBody: FlowBody | null = current
    ? {
        steps: JSON.parse(current.steps),
        loadProfile: current.load_profile ? JSON.parse(current.load_profile) : null,
      }
    : null
  const nextBody: FlowBody = { steps: body.steps, loadProfile: body.loadProfile ?? null }
  const nextVersion = (current?.version ?? 0) + 1
  const diff = summarizeFlowDiff(prevBody, nextBody)

  const versionId = uuidv7()
  const now = new Date().toISOString()
  const engines = body.engines ? JSON.stringify(body.engines) : flow.engines
  const description = body.description === undefined ? flow.description : body.description

  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(
        `INSERT INTO flow_versions
           (id, flow_id, version, steps, load_profile, author_id, diff_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        versionId,
        flow.id,
        nextVersion,
        JSON.stringify(body.steps),
        body.loadProfile ? JSON.stringify(body.loadProfile) : null,
        actor.actorId,
        diff,
        now,
      ),
      c.env.DB.prepare(
        `UPDATE flows SET current_version_id = ?, engines = ?, description = ?, updated_at = ?
           WHERE id = ?`,
      ).bind(versionId, engines, description, now, flow.id),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'flow.update',
      entityType: 'flow',
      entityId: flow.id,
      before: { version: current?.version ?? null },
      after: { version: nextVersion, diff },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  const row = await loadFlow(c.env.DB, actor.orgId, flow.id)
  const version = await loadVersion(c.env.DB, flow.id, versionId)
  return c.json({ flow: flowDto(row, nextVersion), currentVersion: versionDto(version) })
})

// --- GET /api/flows/:id/versions (viewer) — history -------------------------
flows.get(
  '/flows/:id/versions',
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const flow = await loadFlow(c.env.DB, orgId, c.req.param('id'))
    const rows = await c.env.DB.prepare(
      `SELECT v.id, v.version, v.author_id, v.diff_summary, v.created_at, u.name AS author_name,
            u.email AS author_email
       FROM flow_versions v
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.flow_id = ? ORDER BY v.version DESC`,
    )
      .bind(flow.id)
      .all<{
        id: string
        version: number
        author_id: string
        diff_summary: string | null
        created_at: string
        author_name: string | null
        author_email: string | null
      }>()
    return c.json({
      versions: rows.results.map((r) => ({
        id: r.id,
        version: r.version,
        authorId: r.author_id,
        authorName: r.author_name,
        authorEmail: r.author_email,
        diffSummary: r.diff_summary,
        createdAt: r.created_at,
        isCurrent: r.id === flow.current_version_id,
      })),
    })
  },
)

// --- GET /api/flows/:id/versions/:v (viewer) — a specific version -----------
flows.get(
  '/flows/:id/versions/:v',
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const flow = await loadFlow(c.env.DB, orgId, c.req.param('id'))
    const versionNum = Number(c.req.param('v'))
    if (!Number.isInteger(versionNum)) throw new HttpError('bad_request', 'Invalid version number')
    const row = await c.env.DB.prepare(
      `SELECT * FROM flow_versions WHERE flow_id = ? AND version = ?`,
    )
      .bind(flow.id, versionNum)
      .first<VersionRow>()
    if (!row) throw new HttpError('not_found', 'Version not found')
    return c.json({ version: versionDto(row) })
  },
)

// --- DELETE /api/flows/:id (editor) — soft delete ---------------------------
flows.delete('/flows/:id', authenticate, authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const flow = await loadFlow(c.env.DB, actor.orgId, id)
  const now = new Date().toISOString()

  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(`UPDATE flows SET deleted_at = ?, updated_at = ? WHERE id = ?`).bind(
        now,
        now,
        id,
      ),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'flow.delete',
      entityType: 'flow',
      entityId: id,
      before: { name: flow.name },
      after: null,
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  return c.json({ ok: true })
})

export default flows
