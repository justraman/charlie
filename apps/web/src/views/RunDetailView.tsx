import { AlertCircleIcon, ArrowLeftIcon } from 'lucide-react'
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
  } | null
}

interface LoadThreshold {
  metric: string
  expression: string
  ok: boolean
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
}

const TERMINAL = ['passed', 'failed', 'cancelled']

const ms = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`)
const rate = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}/s`)
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)

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
        summary.checksTotal != null
          ? `${summary.checksPassed ?? 0}/${summary.checksTotal}`
          : '—',
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

export function RunDetailView() {
  const { id: runId } = useParams<{ id: string }>()
  const { can } = useAuth()
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [liveShards, setLiveShards] = useState<Record<number, string>>({})
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
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
          setLog((l) => [...l, `shard ${event.shardIndex} → ${event.status}`])
        } else if (event.type === 'run-status') {
          setLiveStatus(event.status)
          setLog((l) => [...l, `run → ${event.status}`])
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
                <span
                  className={cn('size-2 rounded-full', shardDot(shardStatus(i)))}
                  aria-hidden
                />
                #{i} {shardStatus(i)}
              </span>
            ))}
          </div>
          {log.length > 0 && (
            <div className="bg-muted max-h-52 overflow-y-auto rounded-md p-3 font-mono text-xs">
              {log.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines
                <div key={i}>{line}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {detail.report && (
        <Card>
          <CardHeader>
            <CardTitle>Report</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              Result: <strong>{detail.report.status}</strong>
            </p>
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
              <strong className="text-sm">Shard #{r.shardIndex}</strong>
              <ul className="text-muted-foreground list-inside list-disc text-sm">
                {r.flowResults.map((f) => (
                  <li key={f.flow}>
                    {f.flow}: {f.status}
                    {f.error ? ` — ${f.error}` : ''}
                    {typeof f.durationMs === 'number' ? ` (${f.durationMs}ms)` : ''}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3">
                {r.artifactKeys.map((key) => {
                  const url = `/api/runs/${detail.run.id}/artifact?key=${encodeURIComponent(key)}`
                  const name = key.split('/').slice(-2).join('/')
                  return key.endsWith('.png') ? (
                    <a key={key} href={url} target="_blank" rel="noreferrer">
                      <img
                        src={url}
                        alt={name}
                        className="max-w-[240px] rounded-lg border"
                      />
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
