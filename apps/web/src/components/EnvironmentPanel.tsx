import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/auth/AuthContext'
import { ApiError, api } from '@/lib/api'
import styles from './EnvironmentPanel.module.css'

interface Environment {
  id: string
  name: string
  baseUrl: string
  headers: Record<string, string>
  secrets: Record<string, string> // masked
}

interface Draft {
  adds: { k: string; v: string }[]
  removes: string[]
}

function emptyDraft(): Draft {
  return { adds: [], removes: [] }
}

export function EnvironmentPanel({ projectId }: { projectId: string }) {
  const { can } = useAuth()
  const [envs, setEnvs] = useState<Environment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  const fail = useCallback(
    (err: unknown) => setError(err instanceof ApiError ? err.message : String(err)),
    [],
  )
  const draftFor = (id: string) => drafts[id] ?? emptyDraft()

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await api.get<{ environments: Environment[] }>(
        `/api/projects/${projectId}/environments`,
      )
      setEnvs(res.environments)
    } catch (err) {
      fail(err)
    }
  }, [projectId, fail])

  useEffect(() => {
    void load()
  }, [load])

  async function createEnv() {
    setBusy(true)
    setError(null)
    try {
      await api.post(`/api/projects/${projectId}/environments`, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
      })
      setName('')
      setBaseUrl('')
      setShowForm(false)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  function updateDraft(id: string, fn: (d: Draft) => Draft) {
    setDrafts((prev) => ({ ...prev, [id]: fn(prev[id] ?? emptyDraft()) }))
  }

  function toggleRemove(id: string, secretName: string) {
    updateDraft(id, (d) => ({
      ...d,
      removes: d.removes.includes(secretName)
        ? d.removes.filter((n) => n !== secretName)
        : [...d.removes, secretName],
    }))
  }

  function addRow(id: string) {
    updateDraft(id, (d) => ({ ...d, adds: [...d.adds, { k: '', v: '' }] }))
  }

  function editRow(id: string, i: number, field: 'k' | 'v', value: string) {
    updateDraft(id, (d) => ({
      ...d,
      adds: d.adds.map((row, j) => (j === i ? { ...row, [field]: value } : row)),
    }))
  }

  async function saveSecrets(env: Environment) {
    const d = draftFor(env.id)
    const patch: Record<string, string | null> = {}
    for (const secretName of d.removes) patch[secretName] = null
    for (const { k, v } of d.adds) if (k.trim()) patch[k.trim()] = v
    if (Object.keys(patch).length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.patch(`/api/environments/${env.id}`, { secrets: patch })
      setDrafts((prev) => ({ ...prev, [env.id]: emptyDraft() }))
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function removeEnv(env: Environment) {
    if (!confirm(`Delete environment "${env.name}"?`)) return
    setBusy(true)
    try {
      await api.delete(`/api/environments/${env.id}`)
      await load()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className={styles.head}>
        <h2>Environments</h2>
        {can('flows.write') && (
          <button type="button" className="btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'Add environment'}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {showForm && (
        <div className={`card ${styles.addForm}`}>
          <label className={styles.field}>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="qa" />
          </label>
          <label className={styles.field}>
            <span>Base URL</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://qa.example.com"
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !name || !baseUrl}
            onClick={createEnv}
          >
            Create
          </button>
        </div>
      )}

      {envs.length === 0 && <p className="muted">No environments yet.</p>}

      {envs.map((env) => {
        const d = draftFor(env.id)
        return (
          <div key={env.id} className={`card ${styles.env}`}>
            <div className={styles.envHead}>
              <div>
                <strong>{env.name}</strong>
                <span className="muted"> — {env.baseUrl}</span>
              </div>
              {can('projects.delete') && (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => removeEnv(env)}
                >
                  Delete
                </button>
              )}
            </div>

            <div className={styles.secrets}>
              <div className={styles.secretsTitle}>Secrets</div>
              {Object.keys(env.secrets).length === 0 && d.adds.length === 0 && (
                <div className="muted">None set.</div>
              )}
              <ul className={styles.secretList}>
                {Object.entries(env.secrets).map(([secretName, mask]) => (
                  <li key={secretName}>
                    <code className={d.removes.includes(secretName) ? styles.struck : undefined}>
                      {secretName}
                    </code>
                    <span className="muted">{mask}</span>
                    {can('secrets.manage') && (
                      <button
                        type="button"
                        className={`btn ${styles.tiny} btn-danger`}
                        onClick={() => toggleRemove(env.id, secretName)}
                      >
                        {d.removes.includes(secretName) ? 'undo' : 'remove'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>

              {can('secrets.manage') ? (
                <>
                  {d.adds.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and transient
                    <div key={i} className={styles.secretAdd}>
                      <input
                        value={row.k}
                        onChange={(e) => editRow(env.id, i, 'k', e.target.value)}
                        placeholder="SECRET_NAME"
                      />
                      <input
                        value={row.v}
                        onChange={(e) => editRow(env.id, i, 'v', e.target.value)}
                        placeholder="value (write-only)"
                        type="password"
                      />
                    </div>
                  ))}
                  <div className={styles.secretButtons}>
                    <button
                      type="button"
                      className={`btn ${styles.tiny}`}
                      onClick={() => addRow(env.id)}
                    >
                      + Add secret
                    </button>
                    <button
                      type="button"
                      className={`btn ${styles.tiny} btn-primary`}
                      disabled={busy}
                      onClick={() => saveSecrets(env)}
                    >
                      Save secrets
                    </button>
                  </div>
                </>
              ) : (
                <p className={`muted ${styles.fine}`}>Secret values are managed by admins.</p>
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}
