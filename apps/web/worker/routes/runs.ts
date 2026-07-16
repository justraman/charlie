import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { githubConfigured } from '../lib/github'
import { clientIp, HttpError, userAgent } from '../lib/http'
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

const RUN_COLS =
  'id, project_id, environment_id, flow_selection, engine, profile, status, trigger, triggered_by, expected_shards, gha_run_id, commit_sha, error, summary, queued_at, started_at, finished_at'

async function loadRun(db: D1Database, orgId: string, id: string): Promise<RunRow> {
  const row = await db
    .prepare(`SELECT ${RUN_COLS} FROM runs WHERE id = ? AND org_id = ?`)
    .bind(id, orgId)
    .first<RunRow>()
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
    const projectId = c.req.query('project')
    const status = c.req.query('status')
    const clauses = ['org_id = ?']
    const binds: unknown[] = [orgId]
    if (projectId) {
      clauses.push('project_id = ?')
      binds.push(projectId)
    }
    if (status) {
      clauses.push('status = ?')
      binds.push(status)
    }
    const rows = await c.env.DB.prepare(
      `SELECT ${RUN_COLS} FROM runs WHERE ${clauses.join(' AND ')} ORDER BY queued_at DESC LIMIT 100`,
    )
      .bind(...binds)
      .all<RunRow>()
    return c.json({ runs: rows.results.map(runDto) })
  },
)

// --- GET /api/runs/:id — detail (+ shards + report) -------------------------
runs.get(
  '/:id',
  authenticate,
  authorize({ capability: 'projects.view', scope: 'runs:read' }),
  async (c) => {
    const { orgId } = c.get('auth')
    const run = await loadRun(c.env.DB, orgId, c.req.param('id'))
    const shards = await c.env.DB.prepare(
      `SELECT shard_index, status, runner, public_ip, started_at, finished_at
       FROM run_shards WHERE run_id = ? ORDER BY shard_index`,
    )
      .bind(run.id)
      .all<{
        shard_index: number
        status: string
        runner: string | null
        public_ip: string | null
        started_at: string | null
        finished_at: string | null
      }>()
    const results = await c.env.DB.prepare(
      `SELECT rs.shard_index, sr.flow_results, sr.artifact_keys
       FROM shard_results sr JOIN run_shards rs ON rs.id = sr.shard_id
      WHERE sr.run_id = ? ORDER BY rs.shard_index`,
    )
      .bind(run.id)
      .all<{ shard_index: number; flow_results: string | null; artifact_keys: string | null }>()

    const report = await c.env.DB.prepare(
      `SELECT status, totals, e2e_summary, load_summary, html_report_key, created_at
       FROM reports WHERE run_id = ?`,
    )
      .bind(run.id)
      .first<{
        status: string
        totals: string | null
        e2e_summary: string | null
        load_summary: string | null
        html_report_key: string | null
        created_at: string
      }>()

    return c.json({
      run: runDto(run),
      shards: shards.results.map((s) => ({
        index: s.shard_index,
        status: s.status,
        runner: s.runner,
        publicIp: s.public_ip,
        startedAt: s.started_at,
        finishedAt: s.finished_at,
      })),
      results: results.results.map((r) => ({
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
    const run = await loadRun(c.env.DB, orgId, c.req.param('id'))
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
    const run = await loadRun(c.env.DB, orgId, c.req.param('id'))
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

// --- POST /api/runs/:id/cancel ----------------------------------------------
runs.post('/:id/cancel', authenticate, authorize({ capability: 'runs.trigger' }), async (c) => {
  const actor = c.get('auth')
  const run = await loadRun(c.env.DB, actor.orgId, c.req.param('id'))
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

  await writeAudited(c.env.DB, [], {
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

export default runs
