// Schedule management. A schedule is a saved run recipe plus a trigger: either
// a cron interval (`cron_expr` → `next_due_at`, swept by the `scheduled`
// handler) or an on-merge watch (`watch_branch`, fired by the GitHub webhook).
// Mounted at /api/schedules with an explicit `authenticate` per route.

import { Hono } from 'hono'
import { z } from 'zod'
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

const SCHEDULE_COLS =
  'id, org_id, project_id, environment_id, flow_selection, engine, profile, trigger_type, cron_expr, watch_branch, enabled, created_by, last_fired_at, next_due_at, created_at, updated_at'

async function loadSchedule(db: D1Database, orgId: string, id: string): Promise<ScheduleRow> {
  const row = await db
    .prepare(`SELECT ${SCHEDULE_COLS} FROM schedules WHERE id = ? AND org_id = ?`)
    .bind(id, orgId)
    .first<ScheduleRow>()
  if (!row) throw new HttpError('not_found', 'Schedule not found')
  return row
}

async function assertProject(db: D1Database, orgId: string, projectId: string): Promise<void> {
  const row = await db
    .prepare(`SELECT 1 FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`)
    .bind(projectId, orgId)
    .first()
  if (!row) throw new HttpError('bad_request', 'Unknown project')
}

async function assertEnvironment(
  db: D1Database,
  projectId: string,
  environmentId: string,
): Promise<void> {
  const row = await db
    .prepare(`SELECT 1 FROM environments WHERE id = ? AND project_id = ? AND deleted_at IS NULL`)
    .bind(environmentId, projectId)
    .first()
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
  const projectId = c.req.query('project')
  const clauses = ['org_id = ?']
  const binds: unknown[] = [orgId]
  if (projectId) {
    clauses.push('project_id = ?')
    binds.push(projectId)
  }
  const rows = await c.env.DB.prepare(
    `SELECT ${SCHEDULE_COLS} FROM schedules WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
  )
    .bind(...binds)
    .all<ScheduleRow>()
  return c.json({ schedules: rows.results.map(scheduleDto) })
})

// --- POST /api/schedules — create -------------------------------------------
schedules.post('/', authenticate, authorize({ capability: 'schedules.manage' }), async (c) => {
  const actor = c.get('auth')
  const body = await parseBody(c, createSchema)
  await assertProject(c.env.DB, actor.orgId, body.projectId)
  await assertEnvironment(c.env.DB, body.projectId, body.environmentId)

  const id = uuidv7()
  const now = new Date().toISOString()
  // A cron schedule that starts enabled needs its first due time immediately.
  const nextDueAt =
    body.triggerType === 'cron' && body.enabled && body.cronExpr
      ? (nextDue(body.cronExpr, new Date(now))?.toISOString() ?? null)
      : null

  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(
        `INSERT INTO schedules
           (id, org_id, project_id, environment_id, flow_selection, engine, profile,
            trigger_type, cron_expr, watch_branch, enabled, created_by,
            last_fired_at, next_due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).bind(
        id,
        actor.orgId,
        body.projectId,
        body.environmentId,
        JSON.stringify(body.flowSelection),
        body.engine,
        body.profile,
        body.triggerType,
        body.triggerType === 'cron' ? body.cronExpr! : null,
        body.triggerType === 'on_merge' ? body.watchBranch! : null,
        body.enabled ? 1 : 0,
        actor.actorId,
        nextDueAt,
        now,
        now,
      ),
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

  const row = await loadSchedule(c.env.DB, actor.orgId, id)
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
  const existing = await loadSchedule(c.env.DB, actor.orgId, c.req.param('id'))
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
    c.env.DB,
    [
      c.env.DB.prepare(
        `UPDATE schedules SET
           flow_selection = ?, engine = ?, profile = ?, cron_expr = ?, watch_branch = ?,
           enabled = ?, next_due_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        body.flowSelection ? JSON.stringify(body.flowSelection) : existing.flow_selection,
        body.engine ?? existing.engine,
        body.profile ?? existing.profile,
        cronExpr,
        body.watchBranch ?? existing.watch_branch,
        enabled ? 1 : 0,
        nextDueAt,
        now,
        existing.id,
      ),
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

  const row = await loadSchedule(c.env.DB, actor.orgId, existing.id)
  return c.json({ schedule: scheduleDto(row) })
})

// --- DELETE /api/schedules/:id ----------------------------------------------
schedules.delete('/:id', authenticate, authorize({ capability: 'schedules.manage' }), async (c) => {
  const actor = c.get('auth')
  const existing = await loadSchedule(c.env.DB, actor.orgId, c.req.param('id'))
  await writeAudited(
    c.env.DB,
    [c.env.DB.prepare(`DELETE FROM schedules WHERE id = ?`).bind(existing.id)],
    {
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
    },
  )
  return c.json({ ok: true })
})

// --- GET /api/schedules/:id/runs — run history ------------------------------
schedules.get('/:id/runs', authenticate, authorize({ capability: 'projects.view' }), async (c) => {
  const { orgId } = c.get('auth')
  const schedule = await loadSchedule(c.env.DB, orgId, c.req.param('id'))
  const rows = await c.env.DB.prepare(
    `SELECT id, engine, profile, status, trigger, commit_sha, queued_at, started_at, finished_at
         FROM runs WHERE schedule_id = ? ORDER BY queued_at DESC LIMIT 50`,
  )
    .bind(schedule.id)
    .all<{
      id: string
      engine: string
      profile: string
      status: string
      trigger: string
      commit_sha: string | null
      queued_at: string
      started_at: string | null
      finished_at: string | null
    }>()
  return c.json({
    runs: rows.results.map((r) => ({
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
