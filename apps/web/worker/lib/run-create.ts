// Run creation, factored out of POST /api/runs so every trigger path — manual
// (HTTP), cron sweep, and the GitHub merge webhook — creates runs identically:
// resolve the (project, environment, flow) selection, insert the run with its
// audit row atomically, initialize the Coordinator DO before dispatch, and
// enqueue. The only differences between triggers are the `trigger` label, the
// actor, and the optional commit/schedule attribution.

import type { Env } from '../env'
import type { ActorKind } from './audit'
import { writeAudited } from './audit'
import { githubConfigured } from './github'
import { HttpError } from './http'
import { uuidv7 } from './ids'
import { callRunDO } from './run-do'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Engine = 'playwright' | 'k6'
export type RunTrigger = 'manual' | 'slack' | 'cron' | 'merge' | 'ci'

export interface FlowSelection {
  flowId: string
  versionId: string
  name: string
}

/** Resolve a project by id or slug within the org (live only). */
export async function resolveProject(db: D1Database, orgId: string, ref: string): Promise<string> {
  const byId = UUID_RE.test(ref)
  const row = await db
    .prepare(
      `SELECT id FROM projects WHERE org_id = ? AND ${byId ? 'id' : 'slug'} = ? AND deleted_at IS NULL`,
    )
    .bind(orgId, ref)
    .first<{ id: string }>()
  if (!row) throw new HttpError('bad_request', `Unknown project: ${ref}`)
  return row.id
}

/** Resolve an environment by id or name within the project (live only). */
export async function resolveEnvironment(
  db: D1Database,
  projectId: string,
  ref: string,
): Promise<string> {
  const byId = UUID_RE.test(ref)
  const row = await db
    .prepare(
      `SELECT id FROM environments WHERE project_id = ? AND ${byId ? 'id' : 'name'} = ? AND deleted_at IS NULL`,
    )
    .bind(projectId, ref)
    .first<{ id: string }>()
  if (!row) throw new HttpError('bad_request', `Unknown environment: ${ref}`)
  return row.id
}

/**
 * Resolve the flow selection for an engine. `names` undefined/empty/["all"]
 * selects every flow; otherwise the named flows must exist. Only flows that
 * declare support for the engine survive; an empty result is a 400.
 */
export async function resolveFlows(
  db: D1Database,
  projectId: string,
  engine: string,
  names: string[] | undefined,
): Promise<FlowSelection[]> {
  const all = !names || names.length === 0 || names.includes('all')
  const rows = await db
    .prepare(
      `SELECT id, name, current_version_id, engines FROM flows
         WHERE project_id = ? AND deleted_at IS NULL AND current_version_id IS NOT NULL`,
    )
    .bind(projectId)
    .all<{ id: string; name: string; current_version_id: string; engines: string }>()

  let selected = rows.results
  if (!all) {
    const want = new Set(names)
    selected = rows.results.filter((r) => want.has(r.name))
    const found = new Set(selected.map((r) => r.name))
    const missing = [...(want as Set<string>)].filter((n) => !found.has(n))
    if (missing.length) throw new HttpError('bad_request', `Unknown flow(s): ${missing.join(', ')}`)
  }
  selected = selected.filter((r) => {
    try {
      return (JSON.parse(r.engines) as string[]).includes(engine)
    } catch {
      return false
    }
  })
  if (selected.length === 0)
    throw new HttpError('bad_request', `No flows support engine "${engine}"`)
  return selected.map((r) => ({ flowId: r.id, versionId: r.current_version_id, name: r.name }))
}

/** E2E splits flows across browser shards; k6 uses one job × many VUs. */
export function sizeShards(engine: string, flowCount: number): number {
  if (engine === 'k6') return 1
  return Math.max(1, flowCount)
}

export interface CreateRunParams {
  orgId: string
  /** Project id or slug. */
  project: string
  /** Environment id or name. */
  environment: string
  engine: Engine
  profile?: string
  /** Flow names or undefined/["all"] for every engine-compatible flow. */
  flows?: string[]
  trigger: RunTrigger
  /** User id for human triggers; null for machine triggers. */
  triggeredBy?: string | null
  commitSha?: string | null
  scheduleId?: string | null
  /** Slack channel to report the terminal result to (slash-command runs). */
  slackChannel?: string | null
  /** Audit attribution. */
  actorId: string | null
  actorKind: ActorKind
  ip?: string | null
  userAgent?: string | null
}

export interface CreateRunResult {
  runId: string
  status: 'queued'
  engine: Engine
  expectedShards: number
  flowSelection: FlowSelection[]
  dispatch: 'queued' | 'skipped-no-github'
}

/**
 * Resolve the selection, create the queued run (+ audit), initialize its
 * Coordinator DO, and enqueue dispatch. Throws HttpError on bad references.
 */
export async function createRun(env: Env, params: CreateRunParams): Promise<CreateRunResult> {
  const db = env.DB
  const projectId = await resolveProject(db, params.orgId, params.project)
  const environmentId = await resolveEnvironment(db, projectId, params.environment)
  const flowSelection = await resolveFlows(db, projectId, params.engine, params.flows)
  const expectedShards = sizeShards(params.engine, flowSelection.length)
  const profile = params.profile ?? 'smoke'

  const runId = uuidv7()
  const now = new Date().toISOString()

  await writeAudited(
    db,
    [
      db
        .prepare(
          `INSERT INTO runs
           (id, org_id, project_id, environment_id, flow_selection, engine, profile, status,
            trigger, triggered_by, expected_shards, commit_sha, schedule_id, slack_channel, queued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          params.orgId,
          projectId,
          environmentId,
          JSON.stringify(flowSelection),
          params.engine,
          profile,
          params.trigger,
          params.triggeredBy ?? null,
          expectedShards,
          params.commitSha ?? null,
          params.scheduleId ?? null,
          params.slackChannel ?? null,
          now,
        ),
    ],
    {
      orgId: params.orgId,
      actorId: params.actorId,
      actorKind: params.actorKind,
      action: 'run.trigger',
      entityType: 'run',
      entityId: runId,
      after: {
        projectId,
        environmentId,
        engine: params.engine,
        profile,
        flows: flowSelection.map((f) => f.name),
        expectedShards,
        trigger: params.trigger,
        commitSha: params.commitSha ?? null,
        scheduleId: params.scheduleId ?? null,
      },
      ip: params.ip,
      userAgent: params.userAgent,
    },
  )

  // Initialize the Coordinator DO before dispatch so callbacks always land.
  await callRunDO(env, runId, '/init', {
    body: {
      runId,
      orgId: params.orgId,
      engine: params.engine,
      expectedShards,
      flowSelection,
    },
  })

  await env.RUNS_QUEUE.send({ runId, orgId: params.orgId })

  return {
    runId,
    status: 'queued',
    engine: params.engine,
    expectedShards,
    flowSelection,
    dispatch: githubConfigured(env) ? 'queued' : 'skipped-no-github',
  }
}
