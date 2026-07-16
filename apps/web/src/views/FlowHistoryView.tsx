import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError, api } from '@/lib/api'
import styles from './FlowHistoryView.module.css'

interface Version {
  id: string
  version: number
  authorName: string | null
  authorEmail: string | null
  diffSummary: string | null
  createdAt: string
  isCurrent: boolean
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString()
}

export function FlowHistoryView() {
  const { id: flowId } = useParams<{ id: string }>()
  const [flowName, setFlowName] = useState('')
  const [backTo, setBackTo] = useState('/projects')
  const [versions, setVersions] = useState<Version[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ version: number; steps: unknown } | null>(null)

  const load = useCallback(async () => {
    if (!flowId) return
    try {
      const flow = await api.get<{ flow: { name: string; projectId: string } }>(
        `/api/flows/${flowId}`,
      )
      setFlowName(flow.flow.name)
      setBackTo(`/projects/${flow.flow.projectId}`)
      const res = await api.get<{ versions: Version[] }>(`/api/flows/${flowId}/versions`)
      setVersions(res.versions)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [flowId])

  useEffect(() => {
    void load()
  }, [load])

  async function view(v: Version) {
    try {
      const res = await api.get<{ version: { version: number; steps: unknown } }>(
        `/api/flows/${flowId}/versions/${v.version}`,
      )
      setSelected(res.version)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="container">
      <Link to={backTo} className={`muted ${styles.back}`}>
        ← Back
      </Link>
      <h1>History: {flowName}</h1>
      {error && <p className="error">{error}</p>}

      <div className={styles.layout}>
        <div className={`card ${styles.list}`}>
          {versions.map((v) => (
            <button
              type="button"
              key={v.id}
              className={`${styles.version} ${selected?.version === v.version ? styles.active : ''}`}
              onClick={() => view(v)}
            >
              <div className={styles.versionHead}>
                <strong>v{v.version}</strong>
                {v.isCurrent && <span className="badge owner">current</span>}
                <span className={`muted ${styles.when}`}>{fmt(v.createdAt)}</span>
              </div>
              <div className="muted">{v.authorName || v.authorEmail || 'unknown'}</div>
              <div className={styles.diff}>{v.diffSummary}</div>
            </button>
          ))}
        </div>

        <div className={`card ${styles.detail}`}>
          {!selected ? (
            <p className="muted">Select a version to view its steps.</p>
          ) : (
            <>
              <h3>v{selected.version} steps</h3>
              <pre>{JSON.stringify(selected.steps, null, 2)}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
