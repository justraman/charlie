import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { ApiError, api } from '@/lib/api'
import styles from './ProjectsView.module.css'

interface Project {
  id: string
  name: string
  slug: string
  description: string | null
  sourceRepo: string | null
}

export function ProjectsView() {
  const { can } = useAuth()
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sourceRepo, setSourceRepo] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get<{ projects: Project[] }>('/api/projects')
      setProjects(res.projects)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function create() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/projects', {
        name: name.trim(),
        description: description.trim() || undefined,
        sourceRepo: sourceRepo.trim() || undefined,
      })
      setName('')
      setDescription('')
      setSourceRepo('')
      setShowForm(false)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="container">
      <div className={styles.head}>
        <h1>Projects</h1>
        {can('flows.write') && (
          <button type="button" className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'New project'}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {showForm && (
        <div className={`card ${styles.form}`}>
          <label className={styles.field}>
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Storefront"
            />
          </label>
          <label className={styles.field}>
            <span>Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>Source repo (optional)</span>
            <input
              value={sourceRepo}
              onChange={(e) => setSourceRepo(e.target.value)}
              placeholder="acme/storefront"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name.trim()}
            onClick={create}
          >
            Create
          </button>
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Slug</th>
              <th>Source repo</th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No projects yet.
                </td>
              </tr>
            )}
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`}>
                    <strong>{p.name}</strong>
                  </Link>
                  <div className="muted">{p.description}</div>
                </td>
                <td>
                  <code>{p.slug}</code>
                </td>
                <td className="muted">{p.sourceRepo || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
