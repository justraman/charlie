import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { EnvironmentPanel } from '@/components/EnvironmentPanel'
import { ApiError, api } from '@/lib/api'
import styles from './ProjectDetailView.module.css'

interface Project {
  id: string
  name: string
  slug: string
  description: string | null
  sourceRepo: string | null
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

  const load = useCallback(async () => {
    if (!projectId) return
    setError(null)
    try {
      const [p, f] = await Promise.all([
        api.get<{ project: Project }>(`/api/projects/${projectId}`),
        api.get<{ flows: Flow[] }>(`/api/projects/${projectId}/flows`),
      ])
      setProject(p.project)
      setFlows(f.flows)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

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
        </div>
      )}
    </div>
  )
}
