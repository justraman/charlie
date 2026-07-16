// Cron sweep: invoked by the Cloudflare Cron Trigger. Selects due cron
// schedules, claims each with a conditional D1 update so a given due time fires
// exactly once even across overlapping ticks, creates a run, and advances
// `next_due_at`. On-merge schedules are handled by the webhook, not here.

import { and, asc, eq, isNotNull, lte } from 'drizzle-orm'
import { createDb } from './db/client'
import { schedules } from './db/schema'
import type { Env } from './env'
import { nextDue } from './lib/cron'
import { createRun } from './lib/run-create'

interface DueRow {
  id: string
  org_id: string
  project_id: string
  environment_id: string
  flow_selection: string
  engine: string
  profile: string
  cron_expr: string | null
  next_due_at: string | null
}

export interface SweepResult {
  fired: string[] // schedule ids that fired this tick
  runs: string[] // run ids created
}

/** Run one cron sweep. `now` is injectable for tests. */
export async function sweepSchedules(env: Env, now: Date = new Date()): Promise<SweepResult> {
  const db = createDb(env.DB)
  const nowIso = now.toISOString()
  const due = await db
    .select({
      id: schedules.id,
      org_id: schedules.org_id,
      project_id: schedules.project_id,
      environment_id: schedules.environment_id,
      flow_selection: schedules.flow_selection,
      engine: schedules.engine,
      profile: schedules.profile,
      cron_expr: schedules.cron_expr,
      next_due_at: schedules.next_due_at,
    })
    .from(schedules)
    .where(
      and(
        eq(schedules.enabled, 1),
        eq(schedules.trigger_type, 'cron'),
        isNotNull(schedules.next_due_at),
        lte(schedules.next_due_at, nowIso),
      ),
    )
    .orderBy(asc(schedules.next_due_at))

  const fired: string[] = []
  const runs: string[] = []

  for (const s of due) {
    const advanced = s.cron_expr ? (nextDue(s.cron_expr, now)?.toISOString() ?? null) : null

    // Claim atomically: only the invocation that still sees the observed
    // next_due_at advances it. `changes === 1` means we won the tick.
    const claim = await db
      .update(schedules)
      .set({ last_fired_at: nowIso, next_due_at: advanced, updated_at: nowIso })
      .where(
        and(
          eq(schedules.id, s.id),
          // Non-null: the `due` query filters on isNotNull(next_due_at).
          eq(schedules.next_due_at, s.next_due_at as string),
          eq(schedules.enabled, 1),
        ),
      )
    if (claim.meta.changes !== 1) continue // another invocation already fired it
    fired.push(s.id)

    try {
      const result = await createRun(env, {
        orgId: s.org_id,
        project: s.project_id,
        environment: s.environment_id,
        engine: s.engine as 'playwright' | 'k6',
        profile: s.profile,
        flows: JSON.parse(s.flow_selection) as string[],
        trigger: 'cron',
        triggeredBy: null,
        scheduleId: s.id,
        actorId: null,
        actorKind: 'system',
      })
      runs.push(result.runId)
    } catch (err) {
      // The tick is already claimed/advanced; log and move on so one broken
      // schedule doesn't wedge the sweep.
      console.error(`[cron] schedule ${s.id} failed to create a run:`, err)
    }
  }

  return { fired, runs }
}
