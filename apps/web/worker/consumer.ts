// Queue consumer: turns a queued run into a dispatched GitHub workflow. Decoupled
// from POST /api/runs so the request returns immediately and dispatch gets
// retries/backpressure for free.

import { and, eq } from 'drizzle-orm'
import { createDb } from './db/client'
import { runs } from './db/schema'
import type { Env } from './env'
import { dispatchWorkflow, githubConfigured, resolveRunId } from './lib/github'
import { callRunDO } from './lib/run-do'
import { runTokenSecret, signRunToken } from './lib/run-token'

export async function dispatchRun(env: Env, runId: string): Promise<void> {
  const db = createDb(env.DB)
  const run = await db
    .select({
      id: runs.id,
      project_id: runs.project_id,
      environment_id: runs.environment_id,
      engine: runs.engine,
      profile: runs.profile,
      expected_shards: runs.expected_shards,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .get()
  if (!run) return
  if (run.status !== 'queued') return // already dispatched, cancelled, or done

  if (!githubConfigured(env)) {
    // Local/dev: no GitHub App. Leave the run queued; the compute plane is
    // simulated by driving the callback routes directly.
    console.info(`[dispatch] GitHub App not configured — skipping dispatch for run ${runId}`)
    return
  }

  const runToken = await signRunToken(runId, runTokenSecret(env))
  const inputs: Record<string, string> = {
    runId,
    projectId: run.project_id,
    environmentId: run.environment_id,
    engine: run.engine,
    profile: run.profile,
    shards: String(run.expected_shards),
    apiUrl: env.APP_BASE_URL,
    runToken,
  }

  try {
    const { dispatchedAt } = await dispatchWorkflow(env, inputs)
    // Resolve the created workflow run id (best-effort; needed for cancel/reconcile).
    let ghaRunId: string | null = null
    for (let attempt = 0; attempt < 5 && !ghaRunId; attempt++) {
      ghaRunId = await resolveRunId(env, { runId, sinceIso: dispatchedAt })
      if (!ghaRunId) await new Promise((r) => setTimeout(r, 1500))
    }
    if (ghaRunId) {
      await db.update(runs).set({ gha_run_id: ghaRunId }).where(eq(runs.id, runId))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[dispatch] failed for run ${runId}:`, message)
    await db
      .update(runs)
      .set({
        status: 'failed',
        error: `dispatch failed: ${message}`,
        finished_at: new Date().toISOString(),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
    // Close the DO so any SSE clients see the terminal state.
    await callRunDO(env, runId, '/cancel', { method: 'POST' }).catch(() => {})
    throw err // let the queue retry (idempotent: status guard above)
  }
}
