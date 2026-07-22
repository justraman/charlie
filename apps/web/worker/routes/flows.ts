import {
  type CodeSpec,
  codeSpecSchema,
  ENGINES,
  type FlowBody,
  flowBodySchema,
  flowCreateSchema,
  loadProfileSchema,
  summarizeCodeDiff,
  summarizeFlowDiff,
} from '@charlie/flow-core'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createDb, type Db } from '../db/client'
import { flow_versions, flows as flowsTable, projects, users } from '../db/schema'
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
  kind: string
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
  code_spec: string | null
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
    kind: row.kind,
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
    code: row.code_spec ? (JSON.parse(row.code_spec) as CodeSpec) : null,
    authorId: row.author_id,
    diffSummary: row.diff_summary,
    createdAt: row.created_at,
  }
}

async function assertProject(db: Db, orgId: string, projectId: string): Promise<void> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId), isNull(projects.deleted_at)))
    .get()
  if (!row) throw new HttpError('not_found', 'Project not found')
}

async function loadFlow(db: Db, orgId: string, id: string): Promise<FlowRow> {
  const row = await db
    .select({
      id: flowsTable.id,
      project_id: flowsTable.project_id,
      name: flowsTable.name,
      description: flowsTable.description,
      current_version_id: flowsTable.current_version_id,
      kind: flowsTable.kind,
      engines: flowsTable.engines,
      origin: flowsTable.origin,
      created_by: flowsTable.created_by,
      created_at: flowsTable.created_at,
      updated_at: flowsTable.updated_at,
    })
    .from(flowsTable)
    .innerJoin(projects, eq(projects.id, flowsTable.project_id))
    .where(and(eq(flowsTable.id, id), eq(projects.org_id, orgId), isNull(flowsTable.deleted_at)))
    .get()
  if (!row) throw new HttpError('not_found', 'Flow not found')
  return row
}

async function loadVersion(db: Db, flowId: string, versionId: string): Promise<VersionRow> {
  const row = await db
    .select()
    .from(flow_versions)
    .where(and(eq(flow_versions.id, versionId), eq(flow_versions.flow_id, flowId)))
    .get()
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
    const db = createDb(c.env.DB)
    await assertProject(db, orgId, projectId)
    const rows = await db
      .select({
        id: flowsTable.id,
        project_id: flowsTable.project_id,
        name: flowsTable.name,
        description: flowsTable.description,
        current_version_id: flowsTable.current_version_id,
        kind: flowsTable.kind,
        engines: flowsTable.engines,
        origin: flowsTable.origin,
        created_by: flowsTable.created_by,
        created_at: flowsTable.created_at,
        updated_at: flowsTable.updated_at,
        current_version: flow_versions.version,
      })
      .from(flowsTable)
      .leftJoin(flow_versions, eq(flow_versions.id, flowsTable.current_version_id))
      .where(and(eq(flowsTable.project_id, projectId), isNull(flowsTable.deleted_at)))
      .orderBy(asc(flowsTable.name))
    return c.json({
      flows: rows.map((r) => flowDto(r, r.current_version)),
    })
  },
)

const createSchema = flowCreateSchema

// --- POST /api/projects/:projectId/flows (editor) — create flow + v1 --------
flows.post(
  '/projects/:projectId/flows',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const projectId = c.req.param('projectId')
    const db = createDb(c.env.DB)
    await assertProject(db, actor.orgId, projectId)
    const body = await parseBody(c, createSchema)

    const clash = await db
      .select({ id: flowsTable.id })
      .from(flowsTable)
      .where(
        and(
          eq(flowsTable.project_id, projectId),
          eq(flowsTable.name, body.name),
          isNull(flowsTable.deleted_at),
        ),
      )
      .limit(1)
      .get()
    if (clash) throw new HttpError('conflict', `A flow named "${body.name}" already exists`)

    const flowId = uuidv7()
    const versionId = uuidv7()
    const now = new Date().toISOString()

    // Both kinds store the same flow row shape; only the version body differs —
    // steps flows persist `steps` (+ optional loadProfile), code flows persist a
    // `code_spec` pointer with `steps` empty. Code flows are Playwright-only.
    const isCode = body.kind === 'code'
    const engines = body.engines
    const versionValues = isCode
      ? {
          steps: '[]',
          load_profile: null,
          code_spec: JSON.stringify(body.code),
          diff_summary: summarizeCodeDiff(null, body.code),
        }
      : {
          steps: JSON.stringify(body.steps),
          load_profile: body.loadProfile ? JSON.stringify(body.loadProfile) : null,
          code_spec: null,
          diff_summary: summarizeFlowDiff(null, {
            steps: body.steps,
            loadProfile: body.loadProfile ?? null,
          }),
        }

    await writeAudited(
      db,
      [
        // FK-safe ordering: flow (no current version) → version → point flow at it.
        db.insert(flowsTable).values({
          id: flowId,
          project_id: projectId,
          name: body.name,
          description: body.description ?? null,
          current_version_id: null,
          kind: body.kind,
          engines: JSON.stringify(engines),
          origin: 'manual',
          created_by: actor.actorId,
          created_at: now,
          updated_at: now,
        }),
        db.insert(flow_versions).values({
          id: versionId,
          flow_id: flowId,
          version: 1,
          author_id: actor.actorId,
          created_at: now,
          ...versionValues,
        }),
        db
          .update(flowsTable)
          .set({ current_version_id: versionId })
          .where(eq(flowsTable.id, flowId)),
      ],
      {
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        action: 'flow.create',
        entityType: 'flow',
        entityId: flowId,
        after: { name: body.name, kind: body.kind, engines, version: 1 },
        ip: clientIp(c),
        userAgent: userAgent(c),
      },
    )

    const row = await loadFlow(db, actor.orgId, flowId)
    return c.json({ flow: flowDto(row, 1) }, 201)
  },
)

// --- GET /api/flows/:id (viewer) — flow + current version -------------------
flows.get('/flows/:id', authenticate, authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const db = createDb(c.env.DB)
  const row = await loadFlow(db, orgId, c.req.param('id'))
  const version = row.current_version_id
    ? await loadVersion(db, row.id, row.current_version_id)
    : null
  return c.json({
    flow: flowDto(row, version?.version ?? null),
    currentVersion: version ? versionDto(version) : null,
  })
})

// A flow's kind is fixed at creation, so PUT is validated against the flow's
// own kind (resolved below) rather than a discriminated union on the body.
const stepsPutSchema = flowBodySchema.extend({
  description: z.string().max(2000).nullish(),
  engines: z.array(z.enum(ENGINES)).min(1).optional(),
  loadProfile: loadProfileSchema.nullish(),
})
const codePutSchema = z.strictObject({
  code: codeSpecSchema,
  description: z.string().max(2000).nullish(),
})

// --- PUT /api/flows/:id (editor) — new version + diff -----------------------
flows.put('/flows/:id', authenticate, authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const flow = await loadFlow(db, actor.orgId, id)

  const current = flow.current_version_id
    ? await loadVersion(db, flow.id, flow.current_version_id)
    : null
  const nextVersion = (current?.version ?? 0) + 1
  const versionId = uuidv7()
  const now = new Date().toISOString()

  // Build the version body + flow-row updates for whichever kind this flow is.
  let versionValues: {
    steps: string
    load_profile: string | null
    code_spec: string | null
    diff_summary: string
  }
  let engines = flow.engines
  let description: string | null

  if (flow.kind === 'code') {
    const body = await parseBody(c, codePutSchema)
    const prevCode: CodeSpec | null = current?.code_spec ? JSON.parse(current.code_spec) : null
    versionValues = {
      steps: '[]',
      load_profile: null,
      code_spec: JSON.stringify(body.code),
      diff_summary: summarizeCodeDiff(prevCode, body.code),
    }
    description = body.description === undefined ? flow.description : body.description
  } else {
    const body = await parseBody(c, stepsPutSchema)
    const prevBody: FlowBody | null = current
      ? {
          steps: JSON.parse(current.steps),
          loadProfile: current.load_profile ? JSON.parse(current.load_profile) : null,
        }
      : null
    const nextBody: FlowBody = { steps: body.steps, loadProfile: body.loadProfile ?? null }
    versionValues = {
      steps: JSON.stringify(body.steps),
      load_profile: body.loadProfile ? JSON.stringify(body.loadProfile) : null,
      code_spec: null,
      diff_summary: summarizeFlowDiff(prevBody, nextBody),
    }
    if (body.engines) engines = JSON.stringify(body.engines)
    description = body.description === undefined ? flow.description : body.description
  }
  const diff = versionValues.diff_summary

  await writeAudited(
    db,
    [
      db.insert(flow_versions).values({
        id: versionId,
        flow_id: flow.id,
        version: nextVersion,
        author_id: actor.actorId,
        created_at: now,
        ...versionValues,
      }),
      db
        .update(flowsTable)
        .set({
          current_version_id: versionId,
          engines,
          description,
          updated_at: now,
        })
        .where(eq(flowsTable.id, flow.id)),
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

  const row = await loadFlow(db, actor.orgId, flow.id)
  const version = await loadVersion(db, flow.id, versionId)
  return c.json({ flow: flowDto(row, nextVersion), currentVersion: versionDto(version) })
})

// --- GET /api/flows/:id/versions (viewer) — history -------------------------
flows.get(
  '/flows/:id/versions',
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const flow = await loadFlow(db, orgId, c.req.param('id'))
    const rows = await db
      .select({
        id: flow_versions.id,
        version: flow_versions.version,
        author_id: flow_versions.author_id,
        diff_summary: flow_versions.diff_summary,
        created_at: flow_versions.created_at,
        author_name: users.name,
        author_email: users.email,
      })
      .from(flow_versions)
      .leftJoin(users, eq(users.id, flow_versions.author_id))
      .where(eq(flow_versions.flow_id, flow.id))
      .orderBy(desc(flow_versions.version))
    return c.json({
      versions: rows.map((r) => ({
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
    const db = createDb(c.env.DB)
    const flow = await loadFlow(db, orgId, c.req.param('id'))
    const versionNum = Number(c.req.param('v'))
    if (!Number.isInteger(versionNum)) throw new HttpError('bad_request', 'Invalid version number')
    const row = await db
      .select()
      .from(flow_versions)
      .where(and(eq(flow_versions.flow_id, flow.id), eq(flow_versions.version, versionNum)))
      .get()
    if (!row) throw new HttpError('not_found', 'Version not found')
    return c.json({ version: versionDto(row) })
  },
)

// --- DELETE /api/flows/:id (editor) — soft delete ---------------------------
flows.delete('/flows/:id', authenticate, authorize({ capability: 'flows.write' }), async (c) => {
  const actor = c.get('auth')
  const id = c.req.param('id')
  const db = createDb(c.env.DB)
  const flow = await loadFlow(db, actor.orgId, id)
  const now = new Date().toISOString()

  await writeAudited(
    db,
    [db.update(flowsTable).set({ deleted_at: now, updated_at: now }).where(eq(flowsTable.id, id))],
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
