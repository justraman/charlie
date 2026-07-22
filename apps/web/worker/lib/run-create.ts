// Run creation, factored out of POST /api/runs so every trigger path — manual
// (HTTP), cron sweep, and the GitHub merge webhook — creates runs identically:
// resolve the (project, environment, flow) selection, insert the run with its
// audit row atomically, initialize the Coordinator DO before dispatch, and
// enqueue. The only differences between triggers are the `trigger` label, the
// actor, and the optional commit/schedule attribution.

import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { createDb, type Db } from '../db/client'
import { environments, flows, projects, runs } from '../db/schema'
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
  kind: 'steps' | 'code'
}

/** Resolve a project by id or slug within the org (live only). */
export async function resolveProject(db: Db, orgId: string, ref: string): Promise<string> {
  const byId = UUID_RE.test(ref)
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.org_id, orgId),
        eq(byId ? projects.id : projects.slug, ref),
        isNull(projects.deleted_at),
      ),
    )
    .get()
  if (!row) throw new HttpError('bad_request', `Unknown project: ${ref}`)
  return row.id
}

/** Resolve an environment by id or name within the project (live only). */
export async function resolveEnvironment(db: Db, projectId: string, ref: string): Promise<string> {
  const byId = UUID_RE.test(ref)
  const row = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.project_id, projectId),
        eq(byId ? environments.id : environments.name, ref),
        isNull(environments.deleted_at),
      ),
    )
    .get()
  if (!row) throw new HttpError('bad_request', `Unknown environment: ${ref}`)
  return row.id
}

/**
 * Resolve the flow selection for an engine. `names` undefined/empty/["all"]
 * selects every flow; otherwise the named flows must exist. Only flows that
 * declare support for the engine survive; an empty result is a 400.
 */
export async function resolveFlows(
  db: Db,
  projectId: string,
  engine: string,
  names: string[] | undefined,
): Promise<FlowSelection[]> {
  const all = !names || names.length === 0 || names.includes('all')
  const rows = await db
    .select({
      id: flows.id,
      name: flows.name,
      current_version_id: flows.current_version_id,
      engines: flows.engines,
      kind: flows.kind,
    })
    .from(flows)
    .where(
      and(
        eq(flows.project_id, projectId),
        isNull(flows.deleted_at),
        isNotNull(flows.current_version_id),
      ),
    )

  let selected = rows
  if (!all) {
    const want = new Set(names)
    selected = rows.filter((r) => want.has(r.name))
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
  // current_version_id is guaranteed non-null by the isNotNull filter above.
  return selected.map((r) => ({
    flowId: r.id,
    versionId: r.current_version_id as string,
    name: r.name,
    kind: (r.kind === 'code' ? 'code' : 'steps') as 'steps' | 'code',
  }))
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
  const db = createDb(env.DB)
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
      db.insert(runs).values({
        id: runId,
        org_id: params.orgId,
        project_id: projectId,
        environment_id: environmentId,
        flow_selection: JSON.stringify(flowSelection),
        engine: params.engine,
        profile,
        status: 'queued',
        trigger: params.trigger,
        triggered_by: params.triggeredBy ?? null,
        expected_shards: expectedShards,
        commit_sha: params.commitSha ?? null,
        schedule_id: params.scheduleId ?? null,
        slack_channel: params.slackChannel ?? null,
        queued_at: now,
      }),
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
