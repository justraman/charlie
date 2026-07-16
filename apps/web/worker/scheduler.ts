// Cron sweep: invoked by the Cloudflare Cron Trigger. Selects due cron
// schedules, claims each with a conditional D1 update so a given due time fires
// exactly once even across overlapping ticks, creates a run, and advances
// `next_due_at`. On-merge schedules are handled by the webhook, not here.

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
  const nowIso = now.toISOString()
  const due = await env.DB.prepare(
    `SELECT id, org_id, project_id, environment_id, flow_selection, engine, profile,
            cron_expr, next_due_at
       FROM schedules
      WHERE enabled = 1 AND trigger_type = 'cron'
        AND next_due_at IS NOT NULL AND next_due_at <= ?
      ORDER BY next_due_at ASC`,
  )
    .bind(nowIso)
    .all<DueRow>()

  const fired: string[] = []
  const runs: string[] = []

  for (const s of due.results) {
    const advanced = s.cron_expr ? (nextDue(s.cron_expr, now)?.toISOString() ?? null) : null

    // Claim atomically: only the invocation that still sees the observed
    // next_due_at advances it. `changes === 1` means we won the tick.
    const claim = await env.DB.prepare(
      `UPDATE schedules SET last_fired_at = ?, next_due_at = ?, updated_at = ?
         WHERE id = ? AND next_due_at = ? AND enabled = 1`,
    )
      .bind(nowIso, advanced, nowIso, s.id, s.next_due_at)
      .run()
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
