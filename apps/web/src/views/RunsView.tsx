import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, api } from '@/lib/api'
import styles from './RunsView.module.css'

interface Run {
  id: string
  engine: string
  profile: string
  status: string
  trigger: string
  flowSelection: { name: string }[]
  queuedAt: string
  expectedShards: number
}

export function RunsView() {
  const [runs, setRuns] = useState<Run[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ runs: Run[] }>('/api/runs')
      setRuns(res.runs)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="container">
      <div className={styles.head}>
        <h1>Runs</h1>
        <button type="button" className="btn" onClick={load}>
          Refresh
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Engine</th>
              <th>Flows</th>
              <th>Status</th>
              <th>Trigger</th>
              <th>Queued</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No runs yet.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`} className={styles.mono}>
                    {r.id.slice(0, 8)}
                  </Link>
                </td>
                <td>
                  <span className="badge">{r.engine}</span>
                </td>
                <td className="muted">{r.flowSelection.map((f) => f.name).join(', ') || '—'}</td>
                <td>
                  <span className={`${styles.status} ${styles[r.status] ?? ''}`}>{r.status}</span>
                </td>
                <td className="muted">{r.trigger}</td>
                <td className="muted">{new Date(r.queuedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
