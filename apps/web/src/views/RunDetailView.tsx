import { AlertCircleIcon, ArrowLeftIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { PageHeader } from '@/components/page-header'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ApiError, api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface FlowResult {
  flow: string
  status: string
  durationMs?: number
  failedStep?: number
  error?: string
}
interface ShardResult {
  shardIndex: number
  flowResults: FlowResult[]
  artifactKeys: string[]
}
interface RunDetail {
  run: {
    id: string
    engine: string
    profile: string
    status: string
    trigger: string
    expectedShards: number
    error: string | null
    queuedAt: string
    startedAt: string | null
    finishedAt: string | null
    flowSelection: { name: string }[]
  }
  shards: { index: number; status: string; runner: string | null }[]
  results: ShardResult[]
  report: {
    status: string
    totals: Record<string, unknown> | null
    e2eSummary: Record<string, unknown> | null
    loadSummary: LoadSummary | null
    pdfReportKey?: string | null
    htmlReportKey?: string | null
  } | null
}

interface LoadThreshold {
  metric: string
  expression: string
  ok: boolean
}
interface LoadDelta {
  current: number | null
  previous: number | null
  deltaPct: number | null
  better: boolean | null
}
interface LoadComparison {
  baselineRunId: string
  baselineAt: string | null
  p50: LoadDelta
  p95: LoadDelta
  p99: LoadDelta
  rps: LoadDelta
  errorRate: LoadDelta
}
interface LoadSummary {
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
  comparison?: LoadComparison | null
}

const TERMINAL = ['passed', 'failed', 'cancelled']

const ms = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`)
const rate = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}/s`)
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)

/** A ± percentage badge for a metric's change vs the baseline run. */
function DeltaBadge({ delta }: { delta: LoadDelta }) {
  if (delta.deltaPct == null) return <span className="text-muted-foreground">—</span>
  const sign = delta.deltaPct > 0 ? '+' : ''
  const color =
    delta.better == null
      ? 'text-muted-foreground'
      : delta.better
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-red-600 dark:text-red-400'
  return (
    <span className={cn('font-medium tabular-nums', color)}>
      {sign}
      {delta.deltaPct.toFixed(1)}%
    </span>
  )
}

/** Comparison of the headline metrics against the last run of the same settings. */
function LoadComparisonTable({ comparison }: { comparison: LoadComparison }) {
  const rows: { label: string; delta: LoadDelta; fmt: (v: number | null) => string }[] = [
    { label: 'p50 latency', delta: comparison.p50, fmt: ms },
    { label: 'p95 latency', delta: comparison.p95, fmt: ms },
    { label: 'p99 latency', delta: comparison.p99, fmt: ms },
    { label: 'requests/sec', delta: comparison.rps, fmt: rate },
    { label: 'error rate', delta: comparison.errorRate, fmt: pct },
  ]
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">Compared with last run</h3>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground text-[11px] uppercase tracking-wide">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Metric</th>
              <th className="px-3 py-2 text-right font-medium">Current</th>
              <th className="px-3 py-2 text-right font-medium">Baseline</th>
              <th className="px-3 py-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b last:border-0">
                <td className="px-3 py-1.5">{r.label}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.fmt(r.delta.current)}</td>
                <td className="text-muted-foreground px-3 py-1.5 text-right tabular-nums">
                  {r.fmt(r.delta.previous)}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <DeltaBadge delta={r.delta} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Semantic color classes for a run/shard status badge. */
function statusBadge(status: string): string {
  switch (status) {
    case 'passed':
      return 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
    case 'failed':
    case 'errored':
      return 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400'
    case 'running':
      return 'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400'
    case 'queued':
    case 'pending':
      return 'border-transparent bg-secondary text-secondary-foreground'
    default:
      return 'border-border bg-transparent text-muted-foreground'
  }
}

/**
 * Which flows a shard carries. Mirrors `flowsForShard` in
 * packages/runner/src/execute.ts: shard i runs flows whose index ≡ i (mod
 * expectedShards). For e2e, `sizeShards` sets expectedShards = flowCount, so
 * each shard carries exactly one flow; k6 uses a single shard for all of them.
 */
function flowsForShard(flows: { name: string }[], total: number, index: number): string[] {
  return flows.filter((_, i) => i % total === index).map((f) => f.name)
}

/** Human label for a shard: its flow name, falling back to the index. */
function shardLabel(flows: { name: string }[], total: number, index: number): string {
  const names = flowsForShard(flows, total, index)
  if (names.length === 0) return `#${index}`
  if (names.length <= 2) return names.join(', ')
  return `${names[0]} +${names.length - 1} more`
}

/** Dot color for a shard status indicator. */
function shardDot(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-blue-500'
    case 'passed':
      return 'bg-emerald-500'
    case 'failed':
    case 'errored':
      return 'bg-red-500'
    default:
      return 'bg-muted-foreground'
  }
}

function LoadReport({ summary }: { summary: LoadSummary }) {
  const latencies = [
    { label: 'p50', value: summary.p50 },
    { label: 'p95', value: summary.p95 },
    { label: 'p99', value: summary.p99 },
  ]
  const maxLatency = Math.max(1, ...latencies.map((l) => l.value ?? 0))
  const metrics = [
    { label: 'p95 latency', value: ms(summary.p95) },
    { label: 'requests/sec', value: rate(summary.rps) },
    { label: 'error rate', value: pct(summary.errorRate) },
    { label: 'total requests', value: summary.requests ?? '—' },
    {
      label: 'checks passed',
      value:
        summary.checksTotal != null ? `${summary.checksPassed ?? 0}/${summary.checksTotal}` : '—',
    },
  ]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-3">
        {metrics.map((m) => (
          <div key={m.label} className="bg-muted/40 rounded-lg border p-3">
            <div className="text-2xl font-semibold tabular-nums">{m.value}</div>
            <div className="text-muted-foreground mt-0.5 text-[11px] uppercase tracking-wide">
              {m.label}
            </div>
          </div>
        ))}
      </div>

      {summary.comparison && <LoadComparisonTable comparison={summary.comparison} />}

      <div>
        <h3 className="mb-2 text-sm font-medium">Latency distribution</h3>
        <div className="flex h-32 items-end gap-5 border-b px-1 pt-2">
          {latencies.map((l) => (
            <div
              key={l.label}
              className="flex h-full max-w-[90px] flex-1 flex-col items-center justify-end gap-1.5"
            >
              <span className="text-xs tabular-nums">{ms(l.value)}</span>
              <div
                className="bg-primary min-h-0.5 w-full rounded-t-md"
                style={{ height: `${((l.value ?? 0) / maxLatency) * 100}%` }}
              />
              <span className="text-muted-foreground text-[11px]">{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">Thresholds</h3>
        {summary.thresholds.length === 0 ? (
          <p className="text-muted-foreground text-sm">No thresholds configured.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {summary.thresholds.map((t) => (
              <div
                key={`${t.metric}:${t.expression}`}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm',
                  t.ok ? 'border-emerald-500/50' : 'border-red-500/50',
                )}
              >
                <Badge
                  className={
                    t.ok
                      ? 'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : 'border-transparent bg-red-500/15 text-red-600 dark:text-red-400'
                  }
                >
                  {t.ok ? 'pass' : 'fail'}
                </Badge>
                <span className="font-mono text-xs">{t.metric}</span>
                <span className="text-muted-foreground font-mono">{t.expression}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

type LogEntry =
  | { kind: 'shard'; shardIndex: number; status: string }
  | { kind: 'run'; status: string }

interface CiStep {
  name: string
  status: string
  conclusion: string | null
  number: number
}
interface CiJob {
  id: string
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  steps: CiStep[]
}
interface CiLogs {
  available: boolean
  reason: string | null
  ghaRunId?: string
  jobs: CiJob[]
}

/** Why a run has no CI logs, in words a QA engineer can act on. */
function ciUnavailableMessage(reason: string | null): string {
  switch (reason) {
    case 'not-configured':
      return 'No GitHub App configured, so this run has no CI logs.'
    case 'no-workflow-run':
      return 'No GitHub Actions run is linked yet — the run is still queued, or dispatch never resolved a workflow run id.'
    default:
      return `Could not load CI logs: ${reason ?? 'unknown error'}`
  }
}

/** A CI job with its steps and, on demand, its log tail. */
function CiJobPanel({ runId, job }: { runId: string; job: CiJob }) {
  const [log, setLog] = useState<{ text: string | null; truncated: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      setLog(
        await api.get<{ text: string | null; truncated: boolean }>(
          `/api/runs/${runId}/ci-logs/${job.id}`,
        ),
      )
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [runId, job.id])

  // The step that is running now, or the one that failed — the useful summary.
  const notable =
    job.steps.find((s) => s.status === 'in_progress') ??
    job.steps.find((s) => s.conclusion === 'failure' || s.conclusion === 'timed_out')

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('size-2 rounded-full', shardDot(ciStatus(job)))} aria-hidden />
        <strong className="text-sm">{job.name}</strong>
        <Badge className={statusBadge(ciStatus(job))}>{job.conclusion ?? job.status}</Badge>
        {notable && (
          <span className="text-muted-foreground text-xs">
            {notable.status === 'in_progress' ? 'running: ' : 'failed at: '}
            {notable.name}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? 'Loading…' : log ? 'Refresh log' : 'View log'}
        </Button>
      </div>

      {err && <p className="text-destructive text-xs">{err}</p>}
      {log && log.text === null && (
        <p className="text-muted-foreground text-xs">
          GitHub has no log for this job yet (it may still be queued, or the log has expired).
        </p>
      )}
      {log?.text && (
        <>
          {log.truncated && (
            <p className="text-muted-foreground text-xs">
              Showing the last {Math.round(log.text.length / 1000)}KB — earlier output truncated.
            </p>
          )}
          <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
            {log.text}
          </pre>
        </>
      )}
    </div>
  )
}

/** Lazily-loaded per-flow log.txt (uploaded by the runner for every flow). */
function FlowLogPanel({ runId, artifactKey }: { runId: string; artifactKey: string }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // ".../<flow>/log.txt" → the flow name, so a multi-flow shard is readable.
  const flow = artifactKey.split('/').slice(-2)[0] ?? 'flow'

  async function load() {
    if (text !== null) return // already loaded
    try {
      const res = await fetch(
        `/api/runs/${runId}/artifact?key=${encodeURIComponent(artifactKey)}`,
        { credentials: 'same-origin' },
      )
      if (!res.ok) throw new Error(`Failed to load log (${res.status})`)
      setText(await res.text())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <details className="rounded-md border px-3 py-2" onToggle={() => void load()}>
      <summary className="cursor-pointer text-xs font-medium">{flow} — log</summary>
      {err && <p className="text-destructive mt-2 text-xs">{err}</p>}
      {text !== null && (
        <pre className="bg-muted mt-2 max-h-80 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
          {text}
        </pre>
      )}
    </details>
  )
}

/** Map a CI job's GitHub status/conclusion onto our shard status vocabulary. */
function ciStatus(job: CiJob): string {
  if (job.status === 'in_progress') return 'running'
  if (job.conclusion === 'success') return 'passed'
  if (job.conclusion === 'failure' || job.conclusion === 'timed_out') return 'failed'
  if (job.conclusion === 'cancelled') return 'cancelled'
  return 'pending'
}

export function RunDetailView() {
  const { id: runId } = useParams<{ id: string }>()
  const { can } = useAuth()
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [liveShards, setLiveShards] = useState<Record<number, string>>({})
  // Structured so shard lines can be labelled with the flow name at render
  // time — the SSE handler's closure has no access to `detail`.
  const [log, setLog] = useState<LogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ci, setCi] = useState<CiLogs | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const loadDetail = useCallback(async () => {
    if (!runId) return
    try {
      const d = await api.get<RunDetail>(`/api/runs/${runId}`)
      setDetail(d)
      setLiveStatus(d.run.status)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [runId])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const loadCi = useCallback(async () => {
    if (!runId) return
    try {
      setCi(await api.get<CiLogs>(`/api/runs/${runId}/ci-logs`))
    } catch {
      /* non-fatal: the CI card just stays empty */
    }
  }, [runId])

  // Job/step status is the only progress signal for a shard that hasn't
  // reported, so poll it while the run is live. `status` is the SSE-updated
  // value, so this stops as soon as the run reaches a terminal state.
  useEffect(() => {
    void loadCi()
    const live = detail && !TERMINAL.includes(liveStatus ?? detail.run.status)
    if (!live) return
    const t = setInterval(() => void loadCi(), 15_000)
    return () => clearInterval(t)
  }, [loadCi, detail, liveStatus])

  // Live progress via SSE from the run's Coordinator DO.
  useEffect(() => {
    if (!runId) return
    const es = new EventSource(`/api/runs/${runId}/events`)
    esRef.current = es
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data)
        if (event.type === 'snapshot' && event.snapshot?.shards) {
          const map: Record<number, string> = {}
          for (const s of event.snapshot.shards) map[s.index] = s.status
          setLiveShards(map)
          if (event.snapshot.status) setLiveStatus(event.snapshot.status)
        } else if (event.type === 'shard-result') {
          setLiveShards((prev) => ({ ...prev, [event.shardIndex]: event.status }))
          setLog((l) => [
            ...l,
            { kind: 'shard', shardIndex: event.shardIndex, status: event.status },
          ])
        } else if (event.type === 'run-status') {
          setLiveStatus(event.status)
          setLog((l) => [...l, { kind: 'run', status: event.status }])
          if (event.terminal) {
            es.close()
            void loadDetail()
          }
        }
      } catch {
        /* ignore malformed event */
      }
    }
    es.onerror = () => {
      // The DO closes the stream on terminal; a closed ES is expected then.
      es.close()
    }
    return () => es.close()
  }, [runId, loadDetail])

  async function cancel() {
    if (!runId || !confirm('Cancel this run?')) return
    try {
      await api.post(`/api/runs/${runId}/cancel`)
      await loadDetail()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  if (!detail) {
    return (
      <div className="space-y-6">
        {error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <p className="text-muted-foreground">Loading…</p>
        )}
      </div>
    )
  }

  const status = liveStatus ?? detail.run.status
  const shardStatus = (index: number) =>
    liveShards[index] ?? detail.shards.find((s) => s.index === index)?.status ?? 'pending'
  const labelOf = (index: number) =>
    shardLabel(detail.run.flowSelection, detail.run.expectedShards, index)
  const canCancel = can('runs.trigger') && !TERMINAL.includes(status)

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to="/runs">
          <ArrowLeftIcon />
          Runs
        </Link>
      </Button>

      <PageHeader
        title={<span className="font-mono">{detail.run.id.slice(0, 8)}</span>}
        description={`${detail.run.engine} · ${detail.run.flowSelection
          .map((f) => f.name)
          .join(', ')} · ${detail.run.trigger}`}
        actions={
          <>
            <Badge className={statusBadge(status)}>{status}</Badge>
            {canCancel && (
              <Button type="button" variant="destructive" onClick={cancel}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {detail.run.error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{detail.run.error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Shards ({detail.run.expectedShards})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: detail.run.expectedShards }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: shard index is the stable identity
              <span
                key={i}
                className="bg-muted/40 inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
              >
                <span className={cn('size-2 rounded-full', shardDot(shardStatus(i)))} aria-hidden />
                <span className="font-medium">{labelOf(i)}</span>
                <span className="text-muted-foreground">{shardStatus(i)}</span>
              </span>
            ))}
          </div>
          {log.length > 0 && (
            <div className="bg-muted max-h-52 overflow-y-auto rounded-md p-3 font-mono text-xs">
              {log.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines
                <div key={i}>
                  {line.kind === 'shard'
                    ? `${labelOf(line.shardIndex)} → ${line.status}`
                    : `run → ${line.status}`}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>CI logs</CardTitle>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadCi()}>
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {!ci && <p className="text-muted-foreground text-sm">Loading…</p>}
          {ci && !ci.available && (
            <p className="text-muted-foreground text-sm">{ciUnavailableMessage(ci.reason)}</p>
          )}
          {ci?.available && ci.jobs.length === 0 && (
            <p className="text-muted-foreground text-sm">
              The workflow run has no jobs yet — GitHub is still scheduling it.
            </p>
          )}
          {ci?.available &&
            ci.jobs.map((job) => <CiJobPanel key={job.id} runId={detail.run.id} job={job} />)}
        </CardContent>
      </Card>

      {detail.report && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle>Report</CardTitle>
            {detail.report.htmlReportKey && (
              <Button asChild variant="outline" size="sm">
                <a href={`/api/runs/${detail.run.id}/report`} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  View report
                </a>
              </Button>
            )}
            {detail.report.pdfReportKey && (
              <Button asChild variant="outline" size="sm">
                <a
                  href={`/api/runs/${detail.run.id}/artifact?key=${encodeURIComponent(detail.report.pdfReportKey)}`}
                  target="_blank"
                  rel="noreferrer"
                  download={`k6-report-${detail.run.id.slice(0, 8)}.pdf`}
                >
                  <DownloadIcon />
                  Download PDF
                </a>
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              Result: <strong>{detail.report.status}</strong>
            </p>
            {/* The Coordinator records *why* it closed a run early (e.g. a
                dead-shard timeout). Surfacing it turns an unexplained "failed"
                into a pointer at the CI logs below. */}
            {typeof detail.report.totals?.reason === 'string' && (
              <p className="text-muted-foreground text-sm">
                Closed early: {detail.report.totals.reason} — the shards below that never reported
                have no result of their own; check the CI logs for the cause.
              </p>
            )}
            {detail.report.e2eSummary && (
              <p className="text-muted-foreground text-sm">
                Flows passed: {String(detail.report.e2eSummary.flowsPassed)} · failed:{' '}
                {String(detail.report.e2eSummary.flowsFailed)}
                {detail.report.e2eSummary.firstFailingFlow
                  ? ` · first failure: ${String(detail.report.e2eSummary.firstFailingFlow)}`
                  : ''}
              </p>
            )}
            {detail.report.loadSummary && <LoadReport summary={detail.report.loadSummary} />}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Results & artifacts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {detail.results.length === 0 && (
            <p className="text-muted-foreground text-sm">No shard results yet.</p>
          )}
          {detail.results.map((r) => (
            <div key={r.shardIndex} className="space-y-2">
              <strong className="text-sm">{labelOf(r.shardIndex)}</strong>
              <ul className="text-muted-foreground list-inside list-disc text-sm">
                {r.flowResults.map((f) => (
                  <li key={f.flow}>
                    {f.flow}: {f.status}
                    {f.error ? ` — ${f.error}` : ''}
                    {typeof f.durationMs === 'number' ? ` (${f.durationMs}ms)` : ''}
                  </li>
                ))}
              </ul>
              {/* The runner writes a log.txt per flow (console output, page
                  errors, per-step results) — worth reading inline rather than
                  as a file link, since it's the first place a step failure
                  explains itself. */}
              {r.artifactKeys
                .filter((k) => k.endsWith('log.txt'))
                .map((key) => (
                  <FlowLogPanel key={key} runId={detail.run.id} artifactKey={key} />
                ))}
              <div className="flex flex-wrap gap-3">
                {r.artifactKeys.map((key) => {
                  if (key.endsWith('log.txt')) return null // rendered inline above
                  const url = `/api/runs/${detail.run.id}/artifact?key=${encodeURIComponent(key)}`
                  const name = key.split('/').slice(-2).join('/')
                  return key.endsWith('.png') ? (
                    <a key={key} href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt={name} className="max-w-[240px] rounded-lg border" />
                    </a>
                  ) : (
                    <a
                      key={key}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs hover:underline"
                    >
                      {name}
                    </a>
                  )
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
