import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { EnvironmentPanel } from '@/components/EnvironmentPanel'
import { RunTriggerPanel } from '@/components/RunTriggerPanel'
import { SchedulesPanel } from '@/components/SchedulesPanel'
import { SuggestedFlowsPanel } from '@/components/SuggestedFlowsPanel'
import { ApiError, api } from '@/lib/api'
import styles from './ProjectDetailView.module.css'

interface Project {
  id: string
  name: string
  slug: string
  description: string | null
  sourceRepo: string | null
  slackChannel: string | null
}
interface Flow {
  id: string
  name: string
  engines: string[]
  origin: string
  currentVersion: number | null
}

export function ProjectDetailView() {
  const { id: projectId } = useParams<{ id: string }>()
  const { can } = useAuth()
  const [project, setProject] = useState<Project | null>(null)
  const [flows, setFlows] = useState<Flow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState('')

  const load = useCallback(async () => {
    if (!projectId) return
    setError(null)
    try {
      const [p, f] = await Promise.all([
        api.get<{ project: Project }>(`/api/projects/${projectId}`),
        api.get<{ flows: Flow[] }>(`/api/projects/${projectId}/flows`),
      ])
      setProject(p.project)
      setChannel(p.project.slackChannel ?? '')
      setFlows(f.flows)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  async function saveChannel() {
    if (!projectId) return
    try {
      await api.patch(`/api/projects/${projectId}`, { slackChannel: channel || null })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="container">
      {error && <p className="error">{error}</p>}
      {project && (
        <div>
          <Link to="/projects" className={`muted ${styles.back}`}>
            ← Projects
          </Link>
          <h1>{project.name}</h1>
          <p className="muted">
            <code>{project.slug}</code>
            {project.description && <span> — {project.description}</span>}
            {project.sourceRepo && <span> · source: {project.sourceRepo}</span>}
          </p>

          {projectId && <EnvironmentPanel projectId={projectId} />}

          <section className={styles.flows}>
            <div className={styles.head}>
              <h2>Flows</h2>
              {can('flows.write') && (
                <Link className="btn btn-primary" to={`/projects/${projectId}/flows/new`}>
                  New flow
                </Link>
              )}
            </div>
            <div className="card">
              <table>
                <thead>
                  <tr>
                    <th>Flow</th>
                    <th>Engines</th>
                    <th>Version</th>
                    <th>Origin</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {flows.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No flows yet.
                      </td>
                    </tr>
                  )}
                  {flows.map((fl) => (
                    <tr key={fl.id}>
                      <td>
                        <strong>{fl.name}</strong>
                      </td>
                      <td>
                        {fl.engines.map((e) => (
                          <span key={e} className={`badge ${styles.badge}`}>
                            {e}
                          </span>
                        ))}
                      </td>
                      <td className="muted">v{fl.currentVersion}</td>
                      <td className="muted">{fl.origin}</td>
                      <td className={styles.right}>
                        <Link className={`btn ${styles.tiny}`} to={`/flows/${fl.id}/edit`}>
                          Edit
                        </Link>
                        <Link className={`btn ${styles.tiny}`} to={`/flows/${fl.id}/history`}>
                          History
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.flows}>
            <div className={styles.head}>
              <h2>Suggested flows (AI)</h2>
            </div>
            {projectId && <SuggestedFlowsPanel projectId={projectId} />}
          </section>

          <section className={styles.flows}>
            <div className={styles.head}>
              <h2>Schedules</h2>
            </div>
            {can('flows.write') && (
              <p className="muted" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span>Default Slack channel for scheduled/merge reports:</span>
                <input
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder="#qa-runs or channel ID"
                  style={{ padding: '0.3rem 0.5rem' }}
                />
                <button type="button" className="btn" onClick={saveChannel}>
                  Save
                </button>
              </p>
            )}
            {projectId && <SchedulesPanel projectId={projectId} />}
          </section>

          <section className={styles.flows}>
            <div className={styles.head}>
              <h2>Runs</h2>
              <Link className="btn" to="/runs">
                All runs
              </Link>
            </div>
            {can('runs.trigger') ? (
              projectId && <RunTriggerPanel projectId={projectId} />
            ) : (
              <p className="muted">You need editor access to trigger runs.</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
