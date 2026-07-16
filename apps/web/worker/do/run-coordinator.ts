// Run Coordinator Durable Object — one instance per run (keyed by run id).
// It is the strongly-consistent coordination point the eventually-consistent D1
// can't be: it tracks shard check-ins, aggregates results, fans out live
// progress over SSE, enforces a dead-shard timeout via an alarm, and on
// completion writes the terminal report to D1.

import { DurableObject } from 'cloudflare:workers'
import { and, eq, notInArray, sql } from 'drizzle-orm'
import { createDb } from '../db/client'
import { environments, projects, reports, run_shards, runs, shard_results } from '../db/schema'
import type { Env } from '../env'
import { uuidv7 } from '../lib/ids'
import { getIntegrationConfig } from '../lib/integrations'
import type {
  FlowResultEntry,
  RunInit,
  RunSnapshot,
  RunStatus,
  ShardResultPayload,
  ShardStatus,
} from '../lib/run-types'
import { buildResultBlocks, postMessage } from '../lib/slack'

const DEFAULT_DEAD_SHARD_TIMEOUT_MS = 10 * 60 * 1000

interface LoadThreshold {
  metric: string
  expression: string
  ok: boolean
}
interface LoadSummaryShape {
  p50: number | null
  p95: number | null
  p99: number | null
  rps: number | null
  errorRate: number | null
  requests: number | null
  checksPassed: number | null
  checksTotal: number | null
  thresholds: LoadThreshold[]
  passed: boolean
}

/**
 * Combine per-shard k6 load summaries into one. k6 runs use a single shard by
 * design (concurrency is VUs, not matrix jobs), so this is usually pass-through;
 * for the multi-shard case it takes the worst-case percentiles, sums throughput,
 * and requires every threshold to hold on every shard.
 */
function aggregateLoad(rows: { metrics: string | null }[]): Record<string, unknown> | null {
  const summaries: LoadSummaryShape[] = []
  for (const r of rows) {
    if (!r.metrics) continue
    try {
      const m = JSON.parse(r.metrics) as LoadSummaryShape
      if (m && Array.isArray(m.thresholds)) summaries.push(m)
    } catch {
      /* ignore malformed */
    }
  }
  if (summaries.length === 0) return null
  if (summaries.length === 1) return summaries[0] as unknown as Record<string, unknown>

  const worst = (key: 'p50' | 'p95' | 'p99') =>
    summaries.reduce<number | null>((acc, s) => {
      const v = s[key]
      return v == null ? acc : acc == null ? v : Math.max(acc, v)
    }, null)
  const sum = (key: 'rps' | 'requests' | 'checksPassed' | 'checksTotal') =>
    summaries.reduce<number | null>((acc, s) => {
      const v = s[key]
      return v == null ? acc : (acc ?? 0) + v
    }, null)
  const totalReqs = sum('requests') ?? 0
  const errorRate =
    totalReqs > 0
      ? summaries.reduce((acc, s) => acc + (s.errorRate ?? 0) * (s.requests ?? 0), 0) / totalReqs
      : (summaries[0]?.errorRate ?? null)
  // Thresholds share the same config across shards; a breach on any shard breaks it.
  const byExpr = new Map<string, LoadThreshold>()
  for (const s of summaries) {
    for (const t of s.thresholds) {
      const existing = byExpr.get(t.expression)
      byExpr.set(t.expression, existing ? { ...t, ok: existing.ok && t.ok } : { ...t })
    }
  }
  const thresholds = [...byExpr.values()]
  return {
    p50: worst('p50'),
    p95: worst('p95'),
    p99: worst('p99'),
    rps: sum('rps'),
    errorRate,
    requests: sum('requests'),
    checksPassed: sum('checksPassed'),
    checksTotal: sum('checksTotal'),
    thresholds,
    passed: thresholds.every((t) => t.ok) && summaries.every((s) => s.passed),
  }
}

interface Meta {
  runId: string
  orgId: string
  engine: 'playwright' | 'k6'
  expectedShards: number
  flowSelection: { flowId: string; versionId: string; name: string }[]
  shards: Record<number, ShardStatus>
  finalizeSeen: boolean
  terminal: boolean
  terminalStatus?: RunStatus
  startedAt?: string
  lastActivityMs: number
}

export class RunCoordinator extends DurableObject<Env> {
  // SSE subscribers (in-memory; connections don't survive hibernation).
  private sessions = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private encoder = new TextEncoder()

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/init':
        return this.handleInit(await request.json())
      case '/shard-result':
        return this.handleShardResult(await request.json())
      case '/finalize':
        return this.handleFinalize()
      case '/cancel':
        return this.handleCancel()
      case '/state':
        return Response.json(await this.snapshot())
      case '/events':
        return this.handleEvents()
      default:
        return new Response('not found', { status: 404 })
    }
  }

  private timeoutMs(): number {
    const v = Number(this.env.DEAD_SHARD_TIMEOUT_MS)
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DEAD_SHARD_TIMEOUT_MS
  }

  private async getMeta(): Promise<Meta | undefined> {
    return this.ctx.storage.get<Meta>('meta')
  }

  private async putMeta(meta: Meta): Promise<void> {
    await this.ctx.storage.put('meta', meta)
  }

  private async handleInit(init: RunInit & { runId: string }): Promise<Response> {
    const existing = await this.getMeta()
    if (existing) return Response.json({ ok: true }) // idempotent
    const shards: Record<number, ShardStatus> = {}
    for (let i = 0; i < init.expectedShards; i++) shards[i] = 'pending'
    const meta: Meta = {
      runId: init.runId,
      orgId: init.orgId,
      engine: init.engine,
      expectedShards: init.expectedShards,
      flowSelection: init.flowSelection,
      shards,
      finalizeSeen: false,
      terminal: false,
      lastActivityMs: Date.now(),
    }
    await this.putMeta(meta)
    await this.ctx.storage.setAlarm(Date.now() + this.timeoutMs())
    return Response.json({ ok: true })
  }

  private async handleShardResult(payload: ShardResultPayload): Promise<Response> {
    const meta = await this.getMeta()
    if (!meta) return new Response('run not initialized', { status: 409 })
    if (meta.terminal) return Response.json({ ok: true, terminal: true })

    const db = createDb(this.env.DB)
    const now = new Date().toISOString()
    // First check-in flips the run to running.
    const firstActivity = !meta.startedAt
    if (firstActivity) {
      meta.startedAt = now
      await db
        .update(runs)
        .set({ status: 'running', started_at: now })
        .where(and(eq(runs.id, meta.runId), eq(runs.status, 'queued')))
    }

    // Persist shard + result rows in D1.
    const shardRowId = uuidv7()
    await db.batch([
      db
        .insert(run_shards)
        .values({
          id: shardRowId,
          run_id: meta.runId,
          shard_index: payload.shardIndex,
          status: payload.status,
          runner: payload.runner ?? null,
          public_ip: payload.publicIp ?? null,
          started_at: meta.startedAt ?? now,
          finished_at: now,
        })
        .onConflictDoUpdate({
          target: [run_shards.run_id, run_shards.shard_index],
          set: {
            status: sql`excluded.status`,
            runner: sql`excluded.runner`,
            public_ip: sql`excluded.public_ip`,
            finished_at: sql`excluded.finished_at`,
          },
        }),
      db.insert(shard_results).values({
        id: uuidv7(),
        run_id: meta.runId,
        shard_id: sql`(SELECT ${run_shards.id} FROM ${run_shards} WHERE ${run_shards.run_id} = ${meta.runId} AND ${run_shards.shard_index} = ${payload.shardIndex})`,
        flow_results: JSON.stringify(payload.flowResults ?? []),
        metrics: payload.metrics != null ? JSON.stringify(payload.metrics) : null,
        runtime_issues:
          payload.runtimeIssues != null ? JSON.stringify(payload.runtimeIssues) : null,
        events: payload.events != null ? JSON.stringify(payload.events) : null,
        artifact_keys: JSON.stringify(payload.artifactKeys ?? []),
        created_at: now,
      }),
    ])

    meta.shards[payload.shardIndex] = payload.status
    meta.lastActivityMs = Date.now()
    await this.putMeta(meta)
    await this.ctx.storage.setAlarm(Date.now() + this.timeoutMs())

    if (firstActivity) this.broadcast({ type: 'run-status', status: 'running' })
    this.broadcast({ type: 'shard-result', shardIndex: payload.shardIndex, status: payload.status })

    // All expected shards reported → finalize.
    if (this.allReported(meta)) await this.finalizeRun(meta, now)
    return Response.json({ ok: true })
  }

  private async handleFinalize(): Promise<Response> {
    const meta = await this.getMeta()
    if (!meta) return new Response('run not initialized', { status: 409 })
    if (meta.terminal) return Response.json({ ok: true, terminal: true })
    meta.finalizeSeen = true
    meta.lastActivityMs = Date.now()
    await this.putMeta(meta)
    // finalize is the compute-side sentinel: close now, marking any missing
    // shard as errored.
    await this.finalizeRun(meta, new Date().toISOString())
    return Response.json({ ok: true })
  }

  private async handleCancel(): Promise<Response> {
    const meta = await this.getMeta()
    if (!meta) {
      return Response.json({ ok: true })
    }
    if (meta.terminal) return Response.json({ ok: true, terminal: true })
    await this.closeRun(meta, 'cancelled', new Date().toISOString())
    return Response.json({ ok: true })
  }

  override async alarm(): Promise<void> {
    const meta = await this.getMeta()
    if (!meta || meta.terminal) return
    const idleMs = Date.now() - meta.lastActivityMs
    if (idleMs >= this.timeoutMs()) {
      // Dead-shard timeout: close with whatever reported; unreported → errored.
      await this.finalizeRun(meta, new Date().toISOString(), 'dead-shard timeout')
    } else {
      await this.ctx.storage.setAlarm(meta.lastActivityMs + this.timeoutMs())
    }
  }

  private allReported(meta: Meta): boolean {
    return Object.values(meta.shards).every((s) => s !== 'pending' && s !== 'running')
  }

  /** Aggregate results and write the terminal report + run status to D1. */
  private async finalizeRun(meta: Meta, nowIso: string, reason?: string): Promise<void> {
    if (meta.terminal) return

    // Any shard that never reported is errored.
    for (let i = 0; i < meta.expectedShards; i++) {
      if (meta.shards[i] === 'pending' || meta.shards[i] === 'running') meta.shards[i] = 'errored'
    }
    const statuses = Object.values(meta.shards)
    const passedShards = statuses.filter((s) => s === 'passed').length
    const failedShards = statuses.length - passedShards
    const runStatus: RunStatus = failedShards === 0 ? 'passed' : 'failed'

    const db = createDb(this.env.DB)
    // Pull both the per-flow results (E2E) and metrics (k6) from every shard.
    const rows = await db
      .select({ flow_results: shard_results.flow_results, metrics: shard_results.metrics })
      .from(shard_results)
      .where(eq(shard_results.run_id, meta.runId))

    const totals = {
      shardsPassed: passedShards,
      shardsFailed: failedShards,
      expectedShards: meta.expectedShards,
      reason: reason ?? null,
    }

    // k6 reports load metrics; Playwright reports a per-flow E2E summary.
    let e2eSummary: Record<string, unknown> | null = null
    let loadSummary: Record<string, unknown> | null = null
    if (meta.engine === 'k6') {
      loadSummary = aggregateLoad(rows)
    } else {
      const flows: FlowResultEntry[] = []
      for (const r of rows) {
        try {
          flows.push(...(JSON.parse(r.flow_results ?? '[]') as FlowResultEntry[]))
        } catch {
          /* ignore malformed */
        }
      }
      const flowsPassed = flows.filter((f) => f.status === 'passed').length
      const firstFailing = flows.find((f) => f.status === 'failed')
      e2eSummary = {
        flowsPassed,
        flowsFailed: flows.length - flowsPassed,
        firstFailingFlow: firstFailing?.flow ?? null,
        firstFailingStep: firstFailing?.failedStep ?? null,
      }
    }

    const denormalized = { ...totals, ...(loadSummary ?? e2eSummary ?? {}) }

    await db.batch([
      db
        .insert(reports)
        .values({
          id: uuidv7(),
          run_id: meta.runId,
          status: runStatus,
          totals: JSON.stringify(totals),
          e2e_summary: e2eSummary ? JSON.stringify(e2eSummary) : null,
          load_summary: loadSummary ? JSON.stringify(loadSummary) : null,
          created_at: nowIso,
        })
        .onConflictDoUpdate({
          target: reports.run_id,
          set: {
            status: sql`excluded.status`,
            totals: sql`excluded.totals`,
            e2e_summary: sql`excluded.e2e_summary`,
            load_summary: sql`excluded.load_summary`,
          },
        }),
      db
        .update(runs)
        .set({
          status: runStatus,
          finished_at: nowIso,
          error: reason ?? null,
          summary: JSON.stringify(denormalized),
        })
        .where(eq(runs.id, meta.runId)),
    ])

    await this.markTerminal(meta, runStatus)
  }

  private async closeRun(meta: Meta, status: RunStatus, nowIso: string): Promise<void> {
    const db = createDb(this.env.DB)
    await db
      .update(runs)
      .set({ status, finished_at: nowIso })
      .where(
        and(eq(runs.id, meta.runId), notInArray(runs.status, ['passed', 'failed', 'cancelled'])),
      )
    await this.markTerminal(meta, status)
  }

  private async markTerminal(meta: Meta, status: RunStatus): Promise<void> {
    meta.terminal = true
    meta.terminalStatus = status
    await this.putMeta(meta)
    await this.ctx.storage.deleteAlarm()
    this.broadcast({ type: 'run-status', status, terminal: true })
    this.closeSessions()
    // Post-run Slack report (best-effort, off the critical path).
    if (status === 'passed' || status === 'failed') {
      this.ctx.waitUntil(
        this.notifySlack(meta, status).catch((err) =>
          console.error(`[slack] report failed for run ${meta.runId}:`, err),
        ),
      )
    }
  }

  /**
   * Post a Block Kit result message to the run's Slack channel (the channel a
   * slash command came from, else the project's default channel). No-ops cleanly
   * when Slack isn't connected or no channel applies.
   */
  private async notifySlack(meta: Meta, status: RunStatus): Promise<void> {
    const db = createDb(this.env.DB)
    const run = await db
      .select({
        slack_channel: runs.slack_channel,
        engine: runs.engine,
        profile: runs.profile,
        summary: runs.summary,
        error: runs.error,
        project_name: projects.name,
        project_channel: projects.slack_channel,
        env_name: environments.name,
      })
      .from(runs)
      .innerJoin(projects, eq(projects.id, runs.project_id))
      .innerJoin(environments, eq(environments.id, runs.environment_id))
      .where(eq(runs.id, meta.runId))
      .get()
    if (!run) return

    const channel = run.slack_channel ?? run.project_channel
    if (!channel) return // nothing subscribed to this run

    const config = await getIntegrationConfig(this.env, meta.orgId, 'slack')
    if (!config?.botToken) return // Slack not connected

    let summary: Record<string, unknown> = {}
    try {
      summary = run.summary ? (JSON.parse(run.summary) as Record<string, unknown>) : {}
    } catch {
      /* ignore malformed */
    }

    let e2eLine: string | null = null
    const loadLines: string[] = []
    if (run.engine === 'k6') {
      const p95 = summary.p95 as number | null
      const errorRate = summary.errorRate as number | null
      if (typeof p95 === 'number') loadLines.push(`p95 ${Math.round(p95)}ms`)
      if (typeof errorRate === 'number')
        loadLines.push(`error rate ${(errorRate * 100).toFixed(2)}%`)
      const thresholds = (summary.thresholds ?? []) as { metric: string; ok: boolean }[]
      const breached = thresholds.filter((t) => !t.ok).map((t) => t.metric)
      if (breached.length) loadLines.push(`Failing threshold: ${breached.join(', ')}`)
    } else {
      const passed = (summary.flowsPassed as number | undefined) ?? 0
      const failed = (summary.flowsFailed as number | undefined) ?? 0
      e2eLine = `${passed}/${passed + failed} flows passed`
      if (summary.firstFailingFlow) e2eLine += ` · first failure: ${summary.firstFailingFlow}`
    }

    const blocks = buildResultBlocks({
      runId: meta.runId,
      project: run.project_name,
      environment: run.env_name,
      engine: run.engine,
      profile: run.profile,
      status,
      appBaseUrl: this.env.APP_BASE_URL,
      e2eLine,
      loadLines,
      reason: run.error,
    })
    const icon = status === 'passed' ? '✅' : '❌'
    await postMessage(
      config.botToken,
      channel,
      blocks,
      `${icon} ${run.project_name} · ${run.env_name} — ${status}`,
      this.env.SLACK_API_BASE,
    )
  }

  private async snapshot(): Promise<RunSnapshot | { runId: null }> {
    const meta = await this.getMeta()
    if (!meta) return { runId: null }
    const shards = Object.entries(meta.shards).map(([index, status]) => ({
      index: Number(index),
      status,
    }))
    const reported = shards.filter((s) => s.status !== 'pending').length
    return {
      runId: meta.runId,
      status: meta.terminalStatus ?? (meta.startedAt ? 'running' : 'queued'),
      expectedShards: meta.expectedShards,
      reportedShards: reported,
      shards,
      finalizeSeen: meta.finalizeSeen,
      terminal: meta.terminal,
    }
  }

  // --- SSE fan-out ----------------------------------------------------------

  private handleEvents(): Response {
    const self = this
    let controllerRef: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controllerRef = controller
        self.sessions.add(controller)
        // Send an initial snapshot so late subscribers catch up.
        const snap = await self.snapshot()
        controller.enqueue(self.sse({ type: 'snapshot', snapshot: snap }))
        // If already terminal, close immediately.
        if ('terminal' in snap && snap.terminal) {
          self.sessions.delete(controller)
          controller.close()
        }
      },
      cancel() {
        self.sessions.delete(controllerRef)
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  private sse(event: unknown): Uint8Array {
    return this.encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
  }

  private broadcast(event: unknown): void {
    const chunk = this.sse(event)
    for (const controller of this.sessions) {
      try {
        controller.enqueue(chunk)
      } catch {
        this.sessions.delete(controller)
      }
    }
  }

  private closeSessions(): void {
    for (const controller of this.sessions) {
      try {
        controller.close()
      } catch {
        /* already closed */
      }
    }
    this.sessions.clear()
  }
}
