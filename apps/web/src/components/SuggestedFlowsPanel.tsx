import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthContext'
import { ApiError, api } from '@/lib/api'
import styles from './SuggestedFlowsPanel.module.css'

interface SourceRef {
  file: string
  route?: string
}
interface Draft {
  id: string
  name: string
  description: string | null
  engines: string[]
  steps: { action: string }[]
  reasoning: string | null
  sourceRefs: SourceRef[]
  status: string
}

export function SuggestedFlowsPanel({ projectId }: { projectId: string }) {
  const { can } = useAuth()
  const editable = can('flows.write')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ drafts: Draft[] }>(`/api/projects/${projectId}/flow-drafts`)
      setDrafts(r.drafts)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function analyze() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await api.post<{ dispatch: string }>(`/api/projects/${projectId}/analyze`)
      setNotice(
        r.dispatch === 'queued'
          ? 'Analysis dispatched — drafts will appear here when it finishes.'
          : 'Analysis queued (GitHub App not configured — no dispatch in this environment).',
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function approve(id: string) {
    try {
      await api.post(`/api/flow-drafts/${id}/approve`)
      setNotice('Draft approved — a new flow was created.')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function reject(id: string) {
    try {
      await api.post(`/api/flow-drafts/${id}/reject`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}
      {notice && <p className={styles.notice}>{notice}</p>}
      {editable && (
        <button type="button" className="btn" disabled={busy} onClick={analyze}>
          Analyze source repo
        </button>
      )}
      {drafts.length === 0 ? (
        <p className="muted" style={{ marginTop: '0.5rem' }}>
          No suggested flows. Point the project at a source repo and run an analysis.
        </p>
      ) : (
        <div
          style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
        >
          {drafts.map((d) => (
            <div key={d.id} className="card">
              <div className={styles.head}>
                <strong>{d.name}</strong>
                <span className="muted">
                  {d.engines.join(', ')} · {d.steps.length} steps
                </span>
              </div>
              {d.description && <p className="muted">{d.description}</p>}
              {d.reasoning && <p className={styles.reasoning}>{d.reasoning}</p>}
              {d.sourceRefs.length > 0 && (
                <p className="muted">
                  Source:{' '}
                  {d.sourceRefs.map((s) => (
                    <span key={`${s.file}:${s.route ?? ''}`} className={styles.ref}>
                      {s.file}
                      {s.route ? ` (${s.route})` : ''}
                    </span>
                  ))}
                </p>
              )}
              <details>
                <summary className="muted">Steps</summary>
                <ol className={styles.steps}>
                  {d.steps.map((s, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered fixed list
                    <li key={i}>{s.action}</li>
                  ))}
                </ol>
              </details>
              {editable && (
                <div className={styles.actions}>
                  <button type="button" className="btn btn-primary" onClick={() => approve(d.id)}>
                    Approve → flow
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => reject(d.id)}>
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
