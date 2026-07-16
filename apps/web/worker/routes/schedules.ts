// Schedule management. A schedule is a saved run recipe plus a trigger: either
// a cron interval (`cron_expr` → `next_due_at`, swept by the `scheduled`
// handler) or an on-merge watch (`watch_branch`, fired by the GitHub webhook).
// Mounted at /api/schedules with an explicit `authenticate` per route.

import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createDb, type Db } from '../db/client'
import { environments, projects, runs, schedules as schedulesTable } from '../db/schema'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { isValidCron, nextDue } from '../lib/cron'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const schedules = new Hono<AppBindings>()

interface ScheduleRow {
  id: string
  org_id: string
  project_id: string
  environment_id: string
  flow_selection: string
  engine: string
  profile: string
  trigger_type: string
  cron_expr: string | null
  watch_branch: string | null
  enabled: number
  created_by: string | null
  last_fired_at: string | null
  next_due_at: string | null
  created_at: string
  updated_at: string
}

function scheduleDto(row: ScheduleRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    flowSelection: JSON.parse(row.flow_selection) as string[],
    engine: row.engine,
    profile: row.profile,
    triggerType: row.trigger_type,
    cronExpr: row.cron_expr,
    watchBranch: row.watch_branch,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    lastFiredAt: row.last_fired_at,
    nextDueAt: row.next_due_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// The column set returned to clients — mirrors ScheduleRow.
const SCHEDULE_COLS = {
  id: schedulesTable.id,
  org_id: schedulesTable.org_id,
  project_id: schedulesTable.project_id,
  environment_id: schedulesTable.environment_id,
  flow_selection: schedulesTable.flow_selection,
  engine: schedulesTable.engine,
  profile: schedulesTable.profile,
  trigger_type: schedulesTable.trigger_type,
  cron_expr: schedulesTable.cron_expr,
  watch_branch: schedulesTable.watch_branch,
  enabled: schedulesTable.enabled,
  created_by: schedulesTable.created_by,
  last_fired_at: schedulesTable.last_fired_at,
  next_due_at: schedulesTable.next_due_at,
  created_at: schedulesTable.created_at,
  updated_at: schedulesTable.updated_at,
}

async function loadSchedule(db: Db, orgId: string, id: string): Promise<ScheduleRow> {
  const row = await db
    .select(SCHEDULE_COLS)
    .from(schedulesTable)
    .where(and(eq(schedulesTable.id, id), eq(schedulesTable.org_id, orgId)))
    .get()
  if (!row) throw new HttpError('not_found', 'Schedule not found')
  return row
}

async function assertProject(db: Db, orgId: string, projectId: string): Promise<void> {
  const row = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.org_id, orgId), isNull(projects.deleted_at)))
    .limit(1)
    .get()
  if (!row) throw new HttpError('bad_request', 'Unknown project')
}

async function assertEnvironment(db: Db, projectId: string, environmentId: string): Promise<void> {
  const row = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.project_id, projectId),
        isNull(environments.deleted_at),
      ),
    )
    .limit(1)
    .get()
  if (!row) throw new HttpError('bad_request', 'Unknown environment for this project')
}

const createSchema = z
  .object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    flowSelection: z.array(z.string()).default(['all']),
    engine: z.enum(['playwright', 'k6']),
    profile: z.enum(['smoke', 'load', 'stress']).default('smoke'),
    triggerType: z.enum(['cron', 'on_merge']),
    cronExpr: z.string().optional(),
    watchBranch: z.string().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.triggerType === 'cron') {
      if (!v.cronExpr || !isValidCron(v.cronExpr)) {
        ctx.addIssue({
          code: 'custom',
          message: 'A valid cron_expr is required',
          path: ['cronExpr'],
        })
      }
    } else if (!v.watchBranch) {
      ctx.addIssue({
        code: 'custom',
        message: 'watch_branch is required for on_merge',
        path: ['watchBranch'],
      })
    }
  })

// --- GET /api/schedules?project= — list -------------------------------------
schedules.get('/', authenticate, authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const db = createDb(c.env.DB)
  const projectId = c.req.query('project')
  const where = projectId
    ? and(eq(schedulesTable.org_id, orgId), eq(schedulesTable.project_id, projectId))
    : eq(schedulesTable.org_id, orgId)
  const rows = await db
    .select(SCHEDULE_COLS)
    .from(schedulesTable)
    .where(where)
    .orderBy(desc(schedulesTable.created_at))
  return c.json({ schedules: rows.map(scheduleDto) })
})

// --- POST /api/schedules — create -------------------------------------------
schedules.post('/', authenticate, authorize({ capability: 'schedules.manage' }), async (c) => {
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  const body = await parseBody(c, createSchema)
  await assertProject(db, actor.orgId, body.projectId)
  await assertEnvironment(db, body.projectId, body.environmentId)

  const id = uuidv7()
  const now = new Date().toISOString()
  // A cron schedule that starts enabled needs its first due time immediately.
  const nextDueAt =
    body.triggerType === 'cron' && body.enabled && body.cronExpr
      ? (nextDue(body.cronExpr, new Date(now))?.toISOString() ?? null)
      : null

  await writeAudited(
    db,
    [
      db.insert(schedulesTable).values({
        id,
        org_id: actor.orgId,
        project_id: body.projectId,
        environment_id: body.environmentId,
        flow_selection: JSON.stringify(body.flowSelection),
        engine: body.engine,
        profile: body.profile,
        trigger_type: body.triggerType,
        cron_expr: body.triggerType === 'cron' ? body.cronExpr! : null,
        watch_branch: body.triggerType === 'on_merge' ? body.watchBranch! : null,
        enabled: body.enabled ? 1 : 0,
        created_by: actor.actorId,
        last_fired_at: null,
        next_due_at: nextDueAt,
        created_at: now,
        updated_at: now,
      }),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'schedule.create',
      entityType: 'schedule',
      entityId: id,
      after: {
        projectId: body.projectId,
        triggerType: body.triggerType,
        cronExpr: body.cronExpr ?? null,
        watchBranch: body.watchBranch ?? null,
        enabled: body.enabled,
      },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  const row = await loadSchedule(db, actor.orgId, id)
  return c.json({ schedule: scheduleDto(row) }, 201)
})

const patchSchema = z.object({
  flowSelection: z.array(z.string()).optional(),
  engine: z.enum(['playwright', 'k6']).optional(),
  profile: z.enum(['smoke', 'load', 'stress']).optional(),
  cronExpr: z.string().optional(),
  watchBranch: z.string().optional(),
  enabled: z.boolean().optional(),
})

// --- PATCH /api/schedules/:id — update / enable-disable ---------------------
schedules.patch('/:id', authenticate, authorize({ capability: 'schedules.manage' }), async (c) => {
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  const existing = await loadSchedule(db, actor.orgId, c.req.param('id'))
  const body = await parseBody(c, patchSchema)

  const cronExpr = body.cronExpr ?? existing.cron_expr
  if (existing.trigger_type === 'cron' && cronExpr && !isValidCron(cronExpr)) {
    throw new HttpError('bad_request', 'Invalid cron_expr')
  }
  const enabled = body.enabled ?? existing.enabled === 1
  const now = new Date().toISOString()

  // Recompute next_due_at when a cron schedule is (re)enabled or its expr
  // changes; clear it when disabled so the sweep skips it.
  let nextDueAt = existing.next_due_at
  if (existing.trigger_type === 'cron') {
    if (!enabled) nextDueAt = null
    else if (body.cronExpr || body.enabled === true || !existing.next_due_at) {
      nextDueAt = cronExpr ? (nextDue(cronExpr, new Date(now))?.toISOString() ?? null) : null
    }
  }

  await writeAudited(
    db,
    [
      db
        .update(schedulesTable)
        .set({
          flow_selection: body.flowSelection
            ? JSON.stringify(body.flowSelection)
            : existing.flow_selection,
          engine: body.engine ?? existing.engine,
          profile: body.profile ?? existing.profile,
          cron_expr: cronExpr,
          watch_branch: body.watchBranch ?? existing.watch_branch,
          enabled: enabled ? 1 : 0,
          next_due_at: nextDueAt,
          updated_at: now,
        })
        .where(eq(schedulesTable.id, existing.id)),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'schedule.update',
      entityType: 'schedule',
      entityId: existing.id,
      before: { enabled: existing.enabled === 1, cronExpr: existing.cron_expr },
      after: { enabled, cronExpr },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  const row = await loadSchedule(db, actor.orgId, existing.id)
  return c.json({ schedule: scheduleDto(row) })
})

// --- DELETE /api/schedules/:id ----------------------------------------------
schedules.delete('/:id', authenticate, authorize({ capability: 'schedules.manage' }), async (c) => {
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  const existing = await loadSchedule(db, actor.orgId, c.req.param('id'))
  await writeAudited(db, [db.delete(schedulesTable).where(eq(schedulesTable.id, existing.id))], {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'schedule.delete',
    entityType: 'schedule',
    entityId: existing.id,
    before: { triggerType: existing.trigger_type, enabled: existing.enabled === 1 },
    after: null,
    ip: clientIp(c),
    userAgent: userAgent(c),
  })
  return c.json({ ok: true })
})

// --- GET /api/schedules/:id/runs — run history ------------------------------
schedules.get('/:id/runs', authenticate, authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const db = createDb(c.env.DB)
  const schedule = await loadSchedule(db, orgId, c.req.param('id'))
  const rows = await db
    .select({
      id: runs.id,
      engine: runs.engine,
      profile: runs.profile,
      status: runs.status,
      trigger: runs.trigger,
      commit_sha: runs.commit_sha,
      queued_at: runs.queued_at,
      started_at: runs.started_at,
      finished_at: runs.finished_at,
    })
    .from(runs)
    .where(eq(runs.schedule_id, schedule.id))
    .orderBy(desc(runs.queued_at))
    .limit(50)
  return c.json({
    runs: rows.map((r) => ({
      id: r.id,
      engine: r.engine,
      profile: r.profile,
      status: r.status,
      trigger: r.trigger,
      commitSha: r.commit_sha,
      queuedAt: r.queued_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    })),
  })
})

export default schedules
