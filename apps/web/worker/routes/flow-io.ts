// Flow import/export. A project's flows can be downloaded as a single JSON
// document and uploaded into any project (or any Charlie instance) that has the
// environments they need — see docs/FLOW_IMPORT_EXPORT.md for the format.
//
// This is how flows authored outside Charlie get in: a QA engineer has their own
// agent write the document (the `charlie-flow-json` skill teaches the format),
// then uploads the file. Nothing in the file is trusted — it is validated
// structurally (Zod, strict), then semantically (name clashes, useFlow
// resolution, reference cycles) against the target project, and only then
// written, in one atomic batch.
//
// Mounted at the API root because it registers full subpaths under both
// /projects/:id and /flows/:id.

import {
  parseFlowDocument,
  summarizeCodeDiff,
  summarizeFlowDiff,
  validateFlowDocument,
} from '@charlie/flow-core'
import { and, eq, isNull } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { createDb, type Db } from '../db/client'
import { flow_versions, flows as flowsTable, projects } from '../db/schema'
import type { AppBindings } from '../env'
import { auditStatement, type Mutation } from '../lib/audit'
import {
  buildFlowDocument,
  documentFilename,
  type ImportMode,
  type ImportPlan,
  loadProjectFlows,
  type ProjectFlow,
  planFlowImport,
  withDependencies,
} from '../lib/flow-portable'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { authenticate, authorize } from '../middleware/auth'

const flowIo = new Hono<AppBindings>()

/** Refuse an obviously oversized upload before parsing it. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

async function loadProject(db: Db, orgId: string, projectId: string) {
  const row = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId), isNull(projects.deleted_at)))
    .get()
  if (!row) throw new HttpError('not_found', 'Project not found')
  return row
}

/** Attach the document to the response as a downloadable .json file. */
function download(c: Context<AppBindings>, filename: string, doc: unknown): Response {
  c.header('content-disposition', `attachment; filename="${filename}"`)
  // Pretty-printed: the file is meant to be opened, diffed, and edited by hand.
  c.header('content-type', 'application/json; charset=utf-8')
  return c.body(`${JSON.stringify(doc, null, 2)}\n`)
}

// --- GET /api/projects/:projectId/flows/export (viewer) ---------------------
// Whole project by default; `?flowIds=a,b` exports a subset.
flowIo.get(
  '/projects/:projectId/flows/export',
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const projectId = c.req.param('projectId')
    const db = createDb(c.env.DB)
    const project = await loadProject(db, orgId, projectId)
    const all = await loadProjectFlows(db, projectId)
    if (all.length === 0) throw new HttpError('not_found', 'This project has no flows to export')

    const idsParam = c.req.query('flowIds')
    let selected: ProjectFlow[] = all
    if (idsParam) {
      const ids = new Set(
        idsParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
      selected = all.filter((f) => ids.has(f.id))
      if (selected.length === 0)
        throw new HttpError('not_found', 'No matching flows in this project')
      // Pull in useFlow targets so the document imports standalone.
      if (c.req.query('deps') !== '0') selected = withDependencies(selected, all)
    }

    const doc = buildFlowDocument(selected, all, { project: project.name })
    const base = selected.length === 1 ? selected[0]!.name : project.name
    return download(c, documentFilename(base), doc)
  },
)

// --- GET /api/flows/:id/export (viewer) — one flow + its dependencies -------
flowIo.get(
  '/flows/:id/export',
  authenticate,
  authorize({ capability: 'projects.view' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const flow = await db
      .select({ id: flowsTable.id, project_id: flowsTable.project_id, name: flowsTable.name })
      .from(flowsTable)
      .innerJoin(projects, eq(projects.id, flowsTable.project_id))
      .where(
        and(
          eq(flowsTable.id, c.req.param('id')),
          eq(projects.org_id, orgId),
          isNull(flowsTable.deleted_at),
        ),
      )
      .get()
    if (!flow) throw new HttpError('not_found', 'Flow not found')

    const project = await loadProject(db, orgId, flow.project_id)
    const all = await loadProjectFlows(db, flow.project_id)
    const seed = all.filter((f) => f.id === flow.id)
    const selected = c.req.query('deps') === '0' ? seed : withDependencies(seed, all)

    const doc = buildFlowDocument(selected, all, { project: project.name })
    return download(c, documentFilename(flow.name), doc)
  },
)

// --- POST /api/projects/:projectId/flows/import (editor) --------------------
// Body is either a bare flow document, or `{ document, mode?, dryRun? }`.
// `mode`/`dryRun` may also be given as query params, so a bare document can be
// posted straight from a file.
const importEnvelopeSchema = z.object({
  document: z.unknown(),
  mode: z.enum(['create', 'upsert']).optional(),
  dryRun: z.boolean().optional(),
})

flowIo.post(
  '/projects/:projectId/flows/import',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const projectId = c.req.param('projectId')
    const db = createDb(c.env.DB)
    const project = await loadProject(db, actor.orgId, projectId)

    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > MAX_UPLOAD_BYTES) {
      throw new HttpError('bad_request', `Document is too large (limit ${MAX_UPLOAD_BYTES} bytes)`)
    }

    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      throw new HttpError('bad_request', 'Uploaded file must be valid JSON')
    }

    // Unwrap the envelope form; otherwise the whole body is the document.
    let document = raw
    let mode = queryMode(c.req.query('mode'))
    let dryRun = c.req.query('dryRun') === '1'
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'document' in raw) {
      const env = importEnvelopeSchema.safeParse(raw)
      if (!env.success) throw new HttpError('bad_request', 'Validation failed', env.error.issues)
      document = env.data.document
      if (env.data.mode) mode = env.data.mode
      if (env.data.dryRun !== undefined) dryRun = env.data.dryRun
    }

    const doc = parseDocumentOr400(document)
    const existing = await loadProjectFlows(db, projectId)
    const plan = planFlowImport({ doc, existing, mode, newId: uuidv7 })

    if (dryRun) return c.json({ dryRun: true, ...planSummary(plan) })

    const now = new Date().toISOString()
    const mutations: Mutation[] = []
    const audits: Mutation[] = []

    for (const flow of plan.flows) {
      const versionId = uuidv7()
      const versionValues =
        flow.kind === 'code'
          ? {
              steps: '[]',
              load_profile: null,
              code_spec: JSON.stringify(flow.code),
              diff_summary: summarizeCodeDiff(flow.previousCode, flow.code!),
            }
          : {
              steps: JSON.stringify(flow.steps),
              load_profile: flow.loadProfile ? JSON.stringify(flow.loadProfile) : null,
              code_spec: null,
              diff_summary: summarizeFlowDiff(
                flow.previousSteps
                  ? { steps: flow.previousSteps, loadProfile: flow.previousLoadProfile }
                  : null,
                { steps: flow.steps, loadProfile: flow.loadProfile },
              ),
            }

      if (flow.action === 'create') {
        // FK-safe ordering, as in POST /flows: flow → version → point flow at it.
        mutations.push(
          db.insert(flowsTable).values({
            id: flow.flowId,
            project_id: projectId,
            name: flow.name,
            description: flow.description,
            current_version_id: null,
            kind: flow.kind,
            engines: JSON.stringify(flow.engines),
            origin: 'import',
            created_by: actor.actorId,
            created_at: now,
            updated_at: now,
          }),
        )
      }
      mutations.push(
        db.insert(flow_versions).values({
          id: versionId,
          flow_id: flow.flowId,
          version: flow.version,
          author_id: actor.actorId,
          created_at: now,
          ...versionValues,
        }),
        db
          .update(flowsTable)
          .set({
            current_version_id: versionId,
            engines: JSON.stringify(flow.engines),
            description: flow.description,
            updated_at: now,
          })
          .where(eq(flowsTable.id, flow.flowId)),
      )

      audits.push(
        auditStatement(db, {
          orgId: actor.orgId,
          actorId: actor.actorId,
          actorKind: actor.actorKind,
          action: flow.action === 'create' ? 'flow.import_create' : 'flow.import_version',
          entityType: 'flow',
          entityId: flow.flowId,
          before: flow.action === 'version' ? { version: flow.version - 1 } : null,
          after: {
            name: flow.name,
            kind: flow.kind,
            engines: flow.engines,
            version: flow.version,
            diff: versionValues.diff_summary,
          },
          ip: clientIp(c),
          userAgent: userAgent(c),
        }),
      )
    }

    // One atomic batch: every flow in the document lands, or none does. The
    // document has at least one flow, so `audits` is never empty (the cast just
    // gives Drizzle the non-empty tuple its signature wants).
    await db.batch([...audits, ...mutations] as [Mutation, ...Mutation[]])

    return c.json({ project: project.name, ...planSummary(plan) }, 201)
  },
)

function planSummary(plan: ImportPlan) {
  return {
    created: plan.created,
    updated: plan.updated,
    secrets: plan.secrets,
    flows: plan.flows.map((f) => ({
      id: f.flowId,
      name: f.name,
      kind: f.kind,
      action: f.action,
      version: f.version,
      engines: f.engines,
      steps: f.kind === 'steps' ? f.steps.length : null,
    })),
  }
}

function queryMode(value: string | undefined): ImportMode {
  if (value === undefined || value === 'create') return 'create'
  if (value === 'upsert') return 'upsert'
  throw new HttpError('bad_request', `Unknown import mode "${value}" (expected create|upsert)`)
}

/** Structural (Zod) then semantic (cross-flow) validation, as a 400 with details. */
function parseDocumentOr400(input: unknown) {
  const result = parseFlowDocument(input)
  if (!result.success) {
    throw new HttpError(
      'bad_request',
      'Flow document failed validation — see details for the exact fields',
      result.error.issues,
    )
  }
  const issues = validateFlowDocument(result.data)
  if (issues.length) {
    throw new HttpError('bad_request', `Flow document has ${issues.length} problem(s)`, issues)
  }
  return result.data
}

export default flowIo
