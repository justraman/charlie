// Run Coordinator Durable Object — one instance per run (keyed by run id).
// It is the strongly-consistent coordination point the eventually-consistent D1
// can't be: it tracks shard check-ins, aggregates results, fans out live
// progress over SSE, enforces a dead-shard timeout via an alarm, and on
// completion writes the terminal report to D1.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { uuidv7 } from '../lib/ids'
import type {
  FlowResultEntry,
  RunInit,
  RunSnapshot,
  RunStatus,
  ShardResultPayload,
  ShardStatus,
} from '../lib/run-types'

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

    const now = new Date().toISOString()
    // First check-in flips the run to running.
    const firstActivity = !meta.startedAt
    if (firstActivity) {
      meta.startedAt = now
      await this.env.DB.prepare(
        `UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`,
      )
        .bind(now, meta.runId)
        .run()
    }

    // Persist shard + result rows in D1.
    const shardRowId = uuidv7()
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO run_shards (id, run_id, shard_index, status, runner, public_ip, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, shard_index) DO UPDATE SET
           status = excluded.status, runner = excluded.runner,
           public_ip = excluded.public_ip, finished_at = excluded.finished_at`,
      ).bind(
        shardRowId,
        meta.runId,
        payload.shardIndex,
        payload.status,
        payload.runner ?? null,
        payload.publicIp ?? null,
        meta.startedAt ?? now,
        now,
      ),
      this.env.DB.prepare(
        `INSERT INTO shard_results
           (id, run_id, shard_id, flow_results, metrics, runtime_issues, events, artifact_keys, created_at)
         VALUES (?, ?, (SELECT id FROM run_shards WHERE run_id = ? AND shard_index = ?), ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uuidv7(),
        meta.runId,
        meta.runId,
        payload.shardIndex,
        JSON.stringify(payload.flowResults ?? []),
        payload.metrics != null ? JSON.stringify(payload.metrics) : null,
        payload.runtimeIssues != null ? JSON.stringify(payload.runtimeIssues) : null,
        payload.events != null ? JSON.stringify(payload.events) : null,
        JSON.stringify(payload.artifactKeys ?? []),
        now,
      ),
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

    // Pull both the per-flow results (E2E) and metrics (k6) from every shard.
    const rows = await this.env.DB.prepare(
      `SELECT flow_results, metrics FROM shard_results WHERE run_id = ?`,
    )
      .bind(meta.runId)
      .all<{ flow_results: string | null; metrics: string | null }>()

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
      loadSummary = aggregateLoad(rows.results)
    } else {
      const flows: FlowResultEntry[] = []
      for (const r of rows.results) {
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

    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO reports (id, run_id, status, totals, e2e_summary, load_summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status, totals = excluded.totals,
           e2e_summary = excluded.e2e_summary, load_summary = excluded.load_summary`,
      ).bind(
        uuidv7(),
        meta.runId,
        runStatus,
        JSON.stringify(totals),
        e2eSummary ? JSON.stringify(e2eSummary) : null,
        loadSummary ? JSON.stringify(loadSummary) : null,
        nowIso,
      ),
      this.env.DB.prepare(
        `UPDATE runs SET status = ?, finished_at = ?, error = ?, summary = ? WHERE id = ?`,
      ).bind(runStatus, nowIso, reason ?? null, JSON.stringify(denormalized), meta.runId),
    ])

    await this.markTerminal(meta, runStatus)
  }

  private async closeRun(meta: Meta, status: RunStatus, nowIso: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE runs SET status = ?, finished_at = ? WHERE id = ? AND status NOT IN ('passed','failed','cancelled')`,
    )
      .bind(status, nowIso, meta.runId)
      .run()
    await this.markTerminal(meta, status)
  }

  private async markTerminal(meta: Meta, status: RunStatus): Promise<void> {
    meta.terminal = true
    meta.terminalStatus = status
    await this.putMeta(meta)
    await this.ctx.storage.deleteAlarm()
    this.broadcast({ type: 'run-status', status, terminal: true })
    this.closeSessions()
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
