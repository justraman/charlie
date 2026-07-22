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
import { slackCredentials } from '../lib/integrations'
import { compareLoad, findBaselineLoad, type LoadComparison } from '../lib/load-compare'
import { buildK6ReportPdf } from '../lib/pdf'
import type {
  FlowResultEntry,
  RunInit,
  RunSnapshot,
  RunStatus,
  ShardResultPayload,
  ShardStatus,
} from '../lib/run-types'
import {
  buildE2EReplyBlocks,
  buildK6ReplyBlocks,
  buildRunParentBlocks,
  postMessage,
  runParentText,
  updateMessage,
  uploadFileToThread,
} from '../lib/slack'

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
  flowSelection: { flowId: string; versionId: string; name: string; kind?: 'steps' | 'code' }[]
  shards: Record<number, ShardStatus>
  finalizeSeen: boolean
  terminal: boolean
  terminalStatus?: RunStatus
  startedAt?: string
  lastActivityMs: number
}

/** Denormalized project/environment context for a run, for Slack + PDF. */
interface RunContext {
  projectId: string
  environmentId: string
  profile: string
  projectName: string
  envName: string
  projectChannel: string | null
  slackChannel: string | null
  threadTs: string | null
}

/** A human-readable label for the run's flow selection. */
function flowLabel(names: string[]): string {
  if (names.length === 1) return names[0]!
  if (names.length <= 3) return names.join(', ')
  return `${names.length} flows`
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
    // Open the Slack thread with a "Started" message (best-effort, off the
    // critical path); its ts is persisted for terminal reporting to reply into.
    this.ctx.waitUntil(
      this.notifyStarted(meta).catch((err) =>
        console.error(`[slack] started message failed for run ${meta.runId}:`, err),
      ),
    )
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
    let pdfReportKey: string | null = null
    if (meta.engine === 'k6') {
      loadSummary = aggregateLoad(rows)
      if (loadSummary) {
        // Compare with the last run of the same settings, and render a PDF.
        // Best-effort: a failure here must not block finalizing the run.
        try {
          pdfReportKey = await this.buildK6Artifacts(db, meta, loadSummary, runStatus, nowIso)
        } catch (err) {
          console.error(`[report] k6 comparison/pdf failed for run ${meta.runId}:`, err)
        }
      }
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
          pdf_report_key: pdfReportKey,
          created_at: nowIso,
        })
        .onConflictDoUpdate({
          target: reports.run_id,
          set: {
            status: sql`excluded.status`,
            totals: sql`excluded.totals`,
            e2e_summary: sql`excluded.e2e_summary`,
            load_summary: sql`excluded.load_summary`,
            pdf_report_key: sql`excluded.pdf_report_key`,
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

  /** Load denormalized project/environment context for a run (names + Slack). */
  private async runContext(
    db: ReturnType<typeof createDb>,
    runId: string,
  ): Promise<RunContext | null> {
    const row = await db
      .select({
        project_id: runs.project_id,
        environment_id: runs.environment_id,
        profile: runs.profile,
        slack_channel: runs.slack_channel,
        slack_thread_ts: runs.slack_thread_ts,
        project_name: projects.name,
        project_channel: projects.slack_channel,
        env_name: environments.name,
      })
      .from(runs)
      .innerJoin(projects, eq(projects.id, runs.project_id))
      .innerJoin(environments, eq(environments.id, runs.environment_id))
      .where(eq(runs.id, runId))
      .get()
    if (!row) return null
    return {
      projectId: row.project_id,
      environmentId: row.environment_id,
      profile: row.profile,
      projectName: row.project_name,
      envName: row.env_name,
      projectChannel: row.project_channel,
      slackChannel: row.slack_channel,
      threadTs: row.slack_thread_ts,
    }
  }

  /**
   * Post the "⏳ Started …" parent message that opens the run's Slack thread, and
   * persist its ts so terminal reporting can edit it and reply in-thread. Uses
   * the slash-command channel if present, else the project's default channel.
   */
  private async notifyStarted(meta: Meta): Promise<void> {
    const creds = slackCredentials(this.env)
    if (!creds) return
    const db = createDb(this.env.DB)
    const ctx = await this.runContext(db, meta.runId)
    if (!ctx) return
    const channel = ctx.slackChannel ?? ctx.projectChannel
    if (!channel) return // nothing subscribed to this run

    const label = flowLabel(meta.flowSelection.map((f) => f.name))
    const blocks = buildRunParentBlocks({
      phase: 'started',
      flowLabel: label,
      project: ctx.projectName,
      environment: ctx.envName,
      runId: meta.runId,
      appBaseUrl: this.env.APP_BASE_URL,
    })
    const text = runParentText({
      phase: 'started',
      flowLabel: label,
      project: ctx.projectName,
      environment: ctx.envName,
    })
    const res = await postMessage(creds.botToken, channel, blocks, text, {
      apiBase: this.env.SLACK_API_BASE,
    })
    // D1 is the source of truth for the thread ts (avoids racing in-memory meta).
    if (res.ok && typeof res.ts === 'string') {
      await db.update(runs).set({ slack_thread_ts: res.ts }).where(eq(runs.id, meta.runId))
    }
  }

  /**
   * Compute the same-settings baseline comparison (mutating `loadSummary` to
   * carry it), render the k6 report to a PDF, and store it in R2. Returns the R2
   * key of the PDF, or null if context is missing.
   */
  private async buildK6Artifacts(
    db: ReturnType<typeof createDb>,
    meta: Meta,
    loadSummary: Record<string, unknown>,
    runStatus: RunStatus,
    nowIso: string,
  ): Promise<string | null> {
    const ctx = await this.runContext(db, meta.runId)
    if (!ctx) return null
    const names = meta.flowSelection.map((f) => f.name)
    const current = {
      p50: (loadSummary.p50 ?? null) as number | null,
      p95: (loadSummary.p95 ?? null) as number | null,
      p99: (loadSummary.p99 ?? null) as number | null,
      rps: (loadSummary.rps ?? null) as number | null,
      errorRate: (loadSummary.errorRate ?? null) as number | null,
    }
    const baseline = await findBaselineLoad(db, {
      runId: meta.runId,
      projectId: ctx.projectId,
      environmentId: ctx.environmentId,
      profile: ctx.profile,
      flowNames: names,
    })
    const comparison: LoadComparison | null = baseline ? compareLoad(current, baseline) : null
    if (comparison) loadSummary.comparison = comparison

    const pdf = buildK6ReportPdf({
      runId: meta.runId,
      project: ctx.projectName,
      environment: ctx.envName,
      profile: ctx.profile,
      status: runStatus,
      createdAt: nowIso,
      summary: loadSummary as unknown as Parameters<typeof buildK6ReportPdf>[0]['summary'],
      comparison,
    })
    const key = `runs/${meta.runId}/k6-report.pdf`
    await this.env.ARTIFACTS.put(key, pdf, { httpMetadata: { contentType: 'application/pdf' } })
    return key
  }

  /**
   * Report a terminal run to Slack: flip the parent "Started" message to
   * "Completed ✅" / "Failed 🔴", then post the results as a threaded reply — a
   * metrics table (+ PDF attachment) for k6, or the flows summary for E2E.
   * No-ops cleanly when Slack isn't connected or no channel applies.
   */
  private async notifySlack(meta: Meta, status: RunStatus): Promise<void> {
    const creds = slackCredentials(this.env)
    if (!creds) return
    const db = createDb(this.env.DB)
    const ctx = await this.runContext(db, meta.runId)
    if (!ctx) return
    const channel = ctx.slackChannel ?? ctx.projectChannel
    if (!channel) return
    const apiBase = this.env.SLACK_API_BASE

    const report = await db
      .select({
        load_summary: reports.load_summary,
        e2e_summary: reports.e2e_summary,
        pdf_report_key: reports.pdf_report_key,
      })
      .from(reports)
      .where(eq(reports.run_id, meta.runId))
      .get()

    // Parent message: edit the started message in place if it exists, else post
    // a fresh terminal message (cron/merge runs that never opened a thread, or a
    // started message that failed to post).
    const phase = status === 'passed' ? 'passed' : 'failed'
    const label = flowLabel(meta.flowSelection.map((f) => f.name))
    const parentArgs = {
      flowLabel: label,
      project: ctx.projectName,
      environment: ctx.envName,
    }
    const parentBlocks = buildRunParentBlocks({
      phase,
      ...parentArgs,
      runId: meta.runId,
      appBaseUrl: this.env.APP_BASE_URL,
    })
    const parentText = runParentText({ phase, ...parentArgs })

    let threadTs = ctx.threadTs
    if (threadTs) {
      await updateMessage(creds.botToken, channel, threadTs, parentBlocks, parentText, apiBase)
    } else {
      const res = await postMessage(creds.botToken, channel, parentBlocks, parentText, { apiBase })
      threadTs = res.ok && typeof res.ts === 'string' ? res.ts : null
    }

    // Threaded results reply.
    if (meta.engine === 'k6') {
      let summary: Record<string, unknown> = {}
      try {
        summary = report?.load_summary ? JSON.parse(report.load_summary) : {}
      } catch {
        /* ignore malformed */
      }
      const comparison = (summary.comparison as LoadComparison | undefined) ?? null
      const replyBlocks = buildK6ReplyBlocks({
        summary: summary as unknown as Parameters<typeof buildK6ReplyBlocks>[0]['summary'],
        comparison,
        hasPdf: Boolean(report?.pdf_report_key),
      })
      await postMessage(creds.botToken, channel, replyBlocks, 'k6 load results', {
        threadTs,
        apiBase,
      })
      // Attach the PDF into the thread (best-effort).
      if (report?.pdf_report_key) {
        try {
          const obj = await this.env.ARTIFACTS.get(report.pdf_report_key)
          if (obj) {
            await uploadFileToThread(
              creds.botToken,
              {
                channel,
                threadTs,
                filename: `k6-report-${meta.runId.slice(0, 8)}.pdf`,
                title: `k6 load report — ${ctx.projectName}@${ctx.envName}`,
                bytes: new Uint8Array(await obj.arrayBuffer()),
              },
              apiBase,
            )
          }
        } catch (err) {
          console.error(`[slack] pdf upload failed for run ${meta.runId}:`, err)
        }
      }
    } else {
      let e2e: Record<string, unknown> = {}
      try {
        e2e = report?.e2e_summary ? JSON.parse(report.e2e_summary) : {}
      } catch {
        /* ignore malformed */
      }
      const replyBlocks = buildE2EReplyBlocks({
        flowsPassed: (e2e.flowsPassed as number | undefined) ?? 0,
        flowsFailed: (e2e.flowsFailed as number | undefined) ?? 0,
        firstFailingFlow: (e2e.firstFailingFlow as string | undefined) ?? null,
        firstFailingStep: (e2e.firstFailingStep as number | undefined) ?? null,
      })
      await postMessage(creds.botToken, channel, replyBlocks, 'E2E results', { threadTs, apiBase })
    }
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
