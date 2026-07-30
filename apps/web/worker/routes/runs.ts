import { and, asc, desc, eq, like, or, type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createDb, type Db } from '../db/client'
import { projects, reports, run_shards, runs as runsTable, shard_results } from '../db/schema'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { fetchJobLog, githubConfigured, listWorkflowJobs } from '../lib/github'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { runRelativePath } from '../lib/report'
import { createRun } from '../lib/run-create'
import { callRunDO } from '../lib/run-do'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const runs = new Hono<AppBindings>()

// NOTE: no blanket `use('*')` here — machine-callback routes under /runs/:id/*
// (bundle, shard-result, finalize, artifacts) live in callbacks.ts and use
// run-token auth. A wildcard session-auth middleware would shadow them. Each
// human-facing route below attaches `authenticate` explicitly.

interface RunRow {
  id: string
  project_id: string
  project_name: string
  environment_id: string
  flow_selection: string
  engine: string
  profile: string
  status: string
  trigger: string
  triggered_by: string | null
  expected_shards: number
  gha_run_id: string | null
  commit_sha: string | null
  error: string | null
  summary: string | null
  queued_at: string
  started_at: string | null
  finished_at: string | null
}

function runDto(row: RunRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    environmentId: row.environment_id,
    flowSelection: JSON.parse(row.flow_selection),
    engine: row.engine,
    profile: row.profile,
    status: row.status,
    trigger: row.trigger,
    triggeredBy: row.triggered_by,
    expectedShards: row.expected_shards,
    ghaRunId: row.gha_run_id,
    commitSha: row.commit_sha,
    error: row.error,
    summary: row.summary ? JSON.parse(row.summary) : null,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

// The column set returned to clients — mirrors RunRow.
const RUN_COLS = {
  id: runsTable.id,
  project_id: runsTable.project_id,
  project_name: projects.name,
  environment_id: runsTable.environment_id,
  flow_selection: runsTable.flow_selection,
  engine: runsTable.engine,
  profile: runsTable.profile,
  status: runsTable.status,
  trigger: runsTable.trigger,
  triggered_by: runsTable.triggered_by,
  expected_shards: runsTable.expected_shards,
  gha_run_id: runsTable.gha_run_id,
  commit_sha: runsTable.commit_sha,
  error: runsTable.error,
  summary: runsTable.summary,
  queued_at: runsTable.queued_at,
  started_at: runsTable.started_at,
  finished_at: runsTable.finished_at,
}

// Whitelist of client sort keys → sortable columns. Anything else falls back
// to queued_at so a bad `sort` param can't inject an arbitrary column.
const SORT_COLUMNS = {
  queuedAt: runsTable.queued_at,
  status: runsTable.status,
  engine: runsTable.engine,
  trigger: runsTable.trigger,
  id: runsTable.id,
} as const
type SortField = keyof typeof SORT_COLUMNS

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

async function loadRun(db: Db, orgId: string, id: string): Promise<RunRow> {
  const row = await db
    .select(RUN_COLS)
    .from(runsTable)
    .innerJoin(projects, eq(projects.id, runsTable.project_id))
    .where(and(eq(runsTable.id, id), eq(runsTable.org_id, orgId)))
    .get()
  if (!row) throw new HttpError('not_found', 'Run not found')
  return row
}

const createSchema = z.object({
  project: z.string().min(1),
  environment: z.string().min(1),
  engine: z.enum(['playwright', 'k6']),
  flows: z.array(z.string()).optional(),
  profile: z.enum(['smoke', 'load', 'stress']).optional(),
  commitSha: z.string().optional(),
})

// --- POST /api/runs — create + enqueue --------------------------------------
runs.post(
  '/',
  authenticate,
  authorize({ capability: 'runs.trigger', scope: 'runs:write' }),
  async (c) => {
    const actor = c.get('auth')
    const body = await parseBody(c, createSchema)

    // API-key callers are CI; human sessions are manual triggers.
    const result = await createRun(c.env, {
      orgId: actor.orgId,
      project: body.project,
      environment: body.environment,
      engine: body.engine,
      profile: body.profile,
      flows: body.flows,
      trigger: actor.actorKind === 'api_key' ? 'ci' : 'manual',
      triggeredBy: actor.actorKind === 'user' ? actor.actorId : null,
      commitSha: body.commitSha,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      ip: clientIp(c),
      userAgent: userAgent(c),
    })

    return c.json(
      {
        runId: result.runId,
        status: result.status,
        engine: result.engine,
        expectedShards: result.expectedShards,
        dispatch: result.dispatch,
      },
      202,
    )
  },
)

// --- GET /api/runs — list ---------------------------------------------------
runs.get(
  '/',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'runs:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)

    // --- filters ---
    const clauses: SQL[] = [eq(runsTable.org_id, orgId)]
    const projectId = c.req.query('project')
    const status = c.req.query('status')
    const engine = c.req.query('engine')
    const search = c.req.query('search')?.trim()
    // `triggeredBy=me` scopes to the caller's own runs (dashboard); an explicit
    // user id also works. Ignored for API keys, which have no user identity.
    const triggeredByParam = c.req.query('triggeredBy')
    const triggeredBy =
      triggeredByParam === 'me'
        ? c.get('auth').actorKind === 'user'
          ? c.get('auth').actorId
          : undefined
        : triggeredByParam
    if (projectId) clauses.push(eq(runsTable.project_id, projectId))
    if (status) clauses.push(eq(runsTable.status, status))
    if (engine) clauses.push(eq(runsTable.engine, engine))
    if (triggeredBy) clauses.push(eq(runsTable.triggered_by, triggeredBy))
    if (search) {
      // flow_selection is JSON text, so a LIKE matches on flow names too.
      const term = `%${search}%`
      clauses.push(
        or(
          like(runsTable.id, term),
          like(runsTable.trigger, term),
          like(runsTable.flow_selection, term),
        ) as SQL,
      )
    }
    const where = and(...clauses)

    // --- sorting ---
    const sortField: SortField =
      (c.req.query('sort') as SortField) in SORT_COLUMNS
        ? (c.req.query('sort') as SortField)
        : 'queuedAt'
    const direction = c.req.query('dir') === 'asc' ? asc : desc
    // queued_at is the stable tiebreaker so paging is deterministic when the
    // primary sort column has duplicate values.
    const orderBy =
      sortField === 'queuedAt'
        ? [direction(runsTable.queued_at)]
        : [direction(SORT_COLUMNS[sortField]), desc(runsTable.queued_at)]

    // --- pagination ---
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT)
    const offset = Math.max(Math.trunc(Number(c.req.query('offset')) || 0), 0)

    const [rows, totalRow] = await Promise.all([
      db
        .select(RUN_COLS)
        .from(runsTable)
        .innerJoin(projects, eq(projects.id, runsTable.project_id))
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ n: sql<number>`count(*)` }).from(runsTable).where(where).get(),
    ])

    return c.json({ runs: rows.map(runDto), total: totalRow?.n ?? 0, limit, offset })
  },
)

// --- GET /api/runs/:id — detail (+ shards + report) -------------------------
runs.get(
  '/:id',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'runs:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const run = await loadRun(db, orgId, c.req.param('id'))
    const shards = await db
      .select({
        shard_index: run_shards.shard_index,
        status: run_shards.status,
        runner: run_shards.runner,
        public_ip: run_shards.public_ip,
        started_at: run_shards.started_at,
        finished_at: run_shards.finished_at,
      })
      .from(run_shards)
      .where(eq(run_shards.run_id, run.id))
      .orderBy(asc(run_shards.shard_index))
    const results = await db
      .select({
        shard_index: run_shards.shard_index,
        flow_results: shard_results.flow_results,
        artifact_keys: shard_results.artifact_keys,
      })
      .from(shard_results)
      .innerJoin(run_shards, eq(run_shards.id, shard_results.shard_id))
      .where(eq(shard_results.run_id, run.id))
      .orderBy(asc(run_shards.shard_index))

    const report = await db
      .select({
        status: reports.status,
        totals: reports.totals,
        e2e_summary: reports.e2e_summary,
        load_summary: reports.load_summary,
        html_report_key: reports.html_report_key,
        pdf_report_key: reports.pdf_report_key,
        created_at: reports.created_at,
      })
      .from(reports)
      .where(eq(reports.run_id, run.id))
      .get()

    return c.json({
      run: runDto(run),
      shards: shards.map((s) => ({
        index: s.shard_index,
        status: s.status,
        runner: s.runner,
        publicIp: s.public_ip,
        startedAt: s.started_at,
        finishedAt: s.finished_at,
      })),
      results: results.map((r) => ({
        shardIndex: r.shard_index,
        flowResults: r.flow_results ? JSON.parse(r.flow_results) : [],
        artifactKeys: r.artifact_keys ? JSON.parse(r.artifact_keys) : [],
      })),
      report: report
        ? {
            status: report.status,
            totals: report.totals ? JSON.parse(report.totals) : null,
            e2eSummary: report.e2e_summary ? JSON.parse(report.e2e_summary) : null,
            loadSummary: report.load_summary ? JSON.parse(report.load_summary) : null,
            htmlReportKey: report.html_report_key,
            pdfReportKey: report.pdf_report_key,
            createdAt: report.created_at,
          }
        : null,
    })
  },
)

// --- GET /api/runs/:id/events — live SSE ------------------------------------
runs.get(
  '/:id/events',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'runs:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const run = await loadRun(db, orgId, c.req.param('id'))
    // Pass the DO's SSE stream straight through to the client.
    return callRunDO(c.env, run.id, '/events', { method: 'GET' })
  },
)

// --- GET /api/runs/:id/artifact?key=... — read an artifact (viewer) ---------
runs.get(
  '/:id/artifact',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'reports:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const run = await loadRun(db, orgId, c.req.param('id'))
    const key = c.req.query('key')
    if (!key || !key.startsWith(`runs/${run.id}/`)) {
      throw new HttpError('bad_request', 'key must belong to this run')
    }
    const obj = await c.env.ARTIFACTS.get(key)
    if (!obj) throw new HttpError('not_found', 'Artifact not found')
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=300',
      },
    })
  },
)

// --- GET /api/runs/:id/ci-logs — CI job list + per-step status ---------------
// The compute plane's own view of the run. This is the only place a failure
// *outside* `charlie execute` shows up (container/install/k6-download failures,
// OOM, a job hitting the GitHub timeout) — cases where no shard result is ever
// posted and the Coordinator can only report a dead-shard timeout.
runs.get(
  '/:id/ci-logs',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'reports:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const run = await loadRun(db, orgId, c.req.param('id'))
    if (!githubConfigured(c.env))
      return c.json({ available: false, reason: 'not-configured', jobs: [] })
    if (!run.gha_run_id) {
      // Either still queued, or dispatch resolution never matched a run id.
      return c.json({ available: false, reason: 'no-workflow-run', jobs: [] })
    }
    try {
      const jobs = await listWorkflowJobs(c.env, run.gha_run_id)
      return c.json({ available: true, reason: null, ghaRunId: run.gha_run_id, jobs })
    } catch (err) {
      return c.json({
        available: false,
        reason: (err as Error).message.slice(0, 200),
        jobs: [],
      })
    }
  },
)

// --- GET /api/runs/:id/ci-logs/:jobId — plain-text log for one CI job --------
runs.get(
  '/:id/ci-logs/:jobId',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'reports:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const run = await loadRun(db, orgId, c.req.param('id'))
    if (!githubConfigured(c.env) || !run.gha_run_id) {
      throw new HttpError('not_found', 'No CI logs for this run')
    }
    // Authorization: a job id is a repo-wide identifier, so confirm this one
    // belongs to *this* run's workflow run before returning its log.
    const jobId = c.req.param('jobId')
    const jobs = await listWorkflowJobs(c.env, run.gha_run_id)
    if (!jobs.some((j) => j.id === jobId)) {
      throw new HttpError('not_found', 'Job does not belong to this run')
    }
    const log = await fetchJobLog(c.env, jobId)
    if (!log) return c.json({ text: null, truncated: false })
    return c.json(log)
  },
)

// --- GET /api/runs/:id/report — the run's HTML (monocart) report -------------
// Redirects to the canonical /report/<path> URL so the report's relative asset
// links resolve within the same path space (served by the wildcard below).
runs.get(
  '/:id/report',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'reports:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const run = await loadRun(db, orgId, c.req.param('id'))
    const report = await db
      .select({ html_report_key: reports.html_report_key })
      .from(reports)
      .where(eq(reports.run_id, run.id))
      .get()
    const rel = report?.html_report_key ? runRelativePath(run.id, report.html_report_key) : null
    if (!rel) throw new HttpError('not_found', 'No HTML report for this run')
    return c.redirect(`/api/runs/${run.id}/report/${rel}`, 302)
  },
)

// --- GET /api/runs/:id/report/* — serve report files by path -----------------
// Maps the sub-path onto the run's R2 prefix (runs/{id}/<path>) so report.html
// and the assets/attachments monocart wrote next to it resolve relatively.
runs.get(
  '/:id/report/*',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'reports:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const db = createDb(c.env.DB)
    const run = await loadRun(db, orgId, c.req.param('id'))
    const marker = '/report/'
    const idx = c.req.path.indexOf(marker)
    const rel = decodeURIComponent(c.req.path.slice(idx + marker.length))
    if (!rel || rel.includes('..')) throw new HttpError('bad_request', 'invalid report path')
    const obj = await c.env.ARTIFACTS.get(`runs/${run.id}/${rel}`)
    if (!obj) throw new HttpError('not_found', 'Report file not found')
    return new Response(obj.body, {
      headers: {
        'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=300',
      },
    })
  },
)

// --- POST /api/runs/:id/cancel ----------------------------------------------
runs.post('/:id/cancel', authenticate, authorize({ capability: 'runs.trigger' }), async (c) => {
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  const run = await loadRun(db, actor.orgId, c.req.param('id'))
  if (['passed', 'failed', 'cancelled'].includes(run.status)) {
    throw new HttpError('conflict', `Run already ${run.status}`)
  }

  // Best-effort cancel of the in-flight GitHub workflow run.
  if (run.gha_run_id && githubConfigured(c.env)) {
    try {
      const { cancelWorkflowRun } = await import('../lib/github')
      await cancelWorkflowRun(c.env, run.gha_run_id)
    } catch (err) {
      console.warn(`[cancel] GitHub cancel failed for run ${run.id}:`, err)
    }
  }

  await callRunDO(c.env, run.id, '/cancel', { method: 'POST' })

  await writeAudited(db, [], {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'run.cancel',
    entityType: 'run',
    entityId: run.id,
    before: { status: run.status },
    after: { status: 'cancelled' },
    ip: clientIp(c),
    userAgent: userAgent(c),
  })

  return c.json({ ok: true })
})

// --- POST /api/runs/:id/rerun -----------------------------------------------
// Re-runs an existing run by creating a *new* run with the same selection, the
// same path the Slack "Re-run" button takes (see rerunFromSlack in slack.ts).
// It deliberately does not re-dispatch the original GitHub workflow run: the
// Coordinator DO has already closed a terminal run, so callbacks.ts would
// reject the replayed shard results and the original's report would never
// update. A fresh run keeps one run row per attempt, which the report and
// load-comparison history both assume.
runs.post(
  '/:id/rerun',
  authenticate,
  authorize({ capability: 'runs.trigger', scope: 'runs:write' }),
  async (c) => {
    const actor = c.get('auth')
    const db = createDb(c.env.DB)
    const original = await loadRun(db, actor.orgId, c.req.param('id'))

    // Names, not ids: createRun re-resolves them so the rerun picks up each
    // flow's *current* version — the point of re-running after a fix.
    const flowNames = (JSON.parse(original.flow_selection) as { name: string }[]).map((f) => f.name)

    const result = await createRun(c.env, {
      orgId: actor.orgId,
      project: original.project_id,
      environment: original.environment_id,
      engine: original.engine as 'playwright' | 'k6',
      profile: original.profile,
      flows: flowNames,
      trigger: actor.actorKind === 'api_key' ? 'ci' : 'manual',
      triggeredBy: actor.actorKind === 'user' ? actor.actorId : null,
      // Carry the commit through so a rerun of a merge-triggered run still
      // reports against the commit it was testing.
      commitSha: original.commit_sha,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      ip: clientIp(c),
      userAgent: userAgent(c),
    })

    return c.json(
      {
        runId: result.runId,
        status: result.status,
        engine: result.engine,
        expectedShards: result.expectedShards,
        dispatch: result.dispatch,
        rerunOf: original.id,
      },
      202,
    )
  },
)

export default runs
