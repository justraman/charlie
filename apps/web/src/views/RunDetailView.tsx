import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { ApiError, api } from '@/lib/api'
import styles from './RunDetailView.module.css'

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

function LoadReport({ summary }: { summary: LoadSummary }) {
  const latencies = [
    { label: 'p50', value: summary.p50 },
    { label: 'p95', value: summary.p95 },
    { label: 'p99', value: summary.p99 },
  ]
  const maxLatency = Math.max(1, ...latencies.map((l) => l.value ?? 0))
  return (
    <div>
      <div className={styles.metrics}>
        <div className={styles.metric}>
          <div className={styles.metricValue}>{ms(summary.p95)}</div>
          <div className={styles.metricLabel}>p95 latency</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricValue}>{rate(summary.rps)}</div>
          <div className={styles.metricLabel}>requests/sec</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricValue}>{pct(summary.errorRate)}</div>
          <div className={styles.metricLabel}>error rate</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricValue}>{summary.requests ?? '—'}</div>
          <div className={styles.metricLabel}>total requests</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricValue}>
            {summary.checksTotal != null
              ? `${summary.checksPassed ?? 0}/${summary.checksTotal}`
              : '—'}
          </div>
          <div className={styles.metricLabel}>checks passed</div>
        </div>
      </div>

      <h3 style={{ margin: '0.5rem 0 0.25rem' }}>Latency distribution</h3>
      <div className={styles.chart}>
        {latencies.map((l) => (
          <div key={l.label} className={styles.barWrap}>
            <span className={styles.barValue}>{ms(l.value)}</span>
            <div
              className={styles.bar}
              style={{ height: `${((l.value ?? 0) / maxLatency) * 100}%` }}
            />
            <span className={styles.barLabel}>{l.label}</span>
          </div>
        ))}
      </div>

      <h3 style={{ margin: '1rem 0 0.25rem' }}>Thresholds</h3>
      {summary.thresholds.length === 0 ? (
        <p className="muted">No thresholds configured.</p>
      ) : (
        <div className={styles.thresholds}>
          {summary.thresholds.map((t) => (
            <div
              key={`${t.metric}:${t.expression}`}
              className={`${styles.threshold} ${t.ok ? styles.ok : styles.bad}`}
            >
              <span className={styles.badge}>{t.ok ? 'pass' : 'fail'}</span>
              <span className={styles.mono}>{t.metric}</span>
              <span className={styles.expr}>{t.expression}</span>
            </div>
          ))}
        </div>
      )}
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
      <div className="container">
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    )
  }

  const status = liveStatus ?? detail.run.status
  const shardStatus = (index: number) =>
    liveShards[index] ?? detail.shards.find((s) => s.index === index)?.status ?? 'pending'
  const canCancel = can('runs.trigger') && !TERMINAL.includes(status)

  return (
    <div className="container">
      <Link to="/runs" className={`muted ${styles.back}`}>
        ← Runs
      </Link>
      <div className={styles.head}>
        <div>
          <h1 className={styles.mono}>{detail.run.id.slice(0, 8)}</h1>
          <p className="muted">
            {detail.run.engine} · {detail.run.flowSelection.map((f) => f.name).join(', ')} ·{' '}
            {detail.run.trigger}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <span className={`${styles.status} ${styles[status] ?? ''}`}>{status}</span>
          {canCancel && (
            <button type="button" className="btn btn-danger" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {detail.run.error && <p className="error">{detail.run.error}</p>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Shards ({detail.run.expectedShards})</h2>
        <div className={styles.shards}>
          {Array.from({ length: detail.run.expectedShards }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: shard index is the stable identity
            <span key={i} className={styles.shard}>
              <span className={`${styles.dot} ${styles[shardStatus(i)] ?? ''}`} />#{i}{' '}
              {shardStatus(i)}
            </span>
          ))}
        </div>
        {log.length > 0 && (
          <div className={styles.log} style={{ marginTop: '0.75rem' }}>
            {log.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
      </div>

      {detail.report && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Report</h2>
          <p>
            Result: <strong>{detail.report.status}</strong>
          </p>
          {detail.report.e2eSummary && (
            <p className="muted">
              Flows passed: {String(detail.report.e2eSummary.flowsPassed)} · failed:{' '}
              {String(detail.report.e2eSummary.flowsFailed)}
              {detail.report.e2eSummary.firstFailingFlow
                ? ` · first failure: ${String(detail.report.e2eSummary.firstFailingFlow)}`
                : ''}
            </p>
          )}
          {detail.report.loadSummary && <LoadReport summary={detail.report.loadSummary} />}
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Results & artifacts</h2>
        {detail.results.length === 0 && <p className="muted">No shard results yet.</p>}
        {detail.results.map((r) => (
          <div key={r.shardIndex} style={{ marginBottom: '1rem' }}>
            <strong>Shard #{r.shardIndex}</strong>
            <ul className="muted">
              {r.flowResults.map((f) => (
                <li key={f.flow}>
                  {f.flow}: {f.status}
                  {f.error ? ` — ${f.error}` : ''}
                  {typeof f.durationMs === 'number' ? ` (${f.durationMs}ms)` : ''}
                </li>
              ))}
            </ul>
            <div className={styles.artifacts}>
              {r.artifactKeys.map((key) => {
                const url = `/api/runs/${detail.run.id}/artifact?key=${encodeURIComponent(key)}`
                const name = key.split('/').slice(-2).join('/')
                return key.endsWith('.png') ? (
                  <a key={key} href={url} target="_blank" rel="noreferrer">
                    <img src={url} alt={name} className={styles.thumb} />
                  </a>
                ) : (
                  <a key={key} href={url} target="_blank" rel="noreferrer" className="mono">
                    {name}
                  </a>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
