import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ApiError, api } from '@/lib/api'
import styles from './RunTriggerPanel.module.css'

interface Env {
  id: string
  name: string
}
interface Flow {
  id: string
  name: string
  engines: string[]
}

export function RunTriggerPanel({ projectId }: { projectId: string }) {
  const navigate = useNavigate()
  const [envs, setEnvs] = useState<Env[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [environmentId, setEnvironmentId] = useState('')
  const [engine, setEngine] = useState<'playwright' | 'k6'>('playwright')
  const [selectedFlows, setSelectedFlows] = useState<string[]>([])
  const [profile, setProfile] = useState<'smoke' | 'load' | 'stress'>('smoke')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [e, f] = await Promise.all([
        api.get<{ environments: Env[] }>(`/api/projects/${projectId}/environments`),
        api.get<{ flows: Flow[] }>(`/api/projects/${projectId}/flows`),
      ])
      setEnvs(e.environments)
      setFlows(f.flows)
      if (e.environments[0]) setEnvironmentId(e.environments[0].id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const eligibleFlows = flows.filter((f) => f.engines.includes(engine))

  function toggleFlow(name: string) {
    setSelectedFlows((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  async function trigger() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<{ runId: string }>('/api/runs', {
        project: projectId,
        environment: environmentId,
        engine,
        // Omit `flows` to mean "all" eligible flows.
        flows: selectedFlows.length > 0 ? selectedFlows : undefined,
        profile,
      })
      navigate(`/runs/${res.runId}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`card ${styles.panel}`}>
      {error && <p className="error">{error}</p>}
      <label className={styles.field}>
        <span>Environment</span>
        <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
          {envs.length === 0 && <option value="">no environments</option>}
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>

      <div className={styles.field}>
        <span>Engine</span>
        <div className={styles.engines}>
          <label>
            <input
              type="radio"
              name="engine"
              checked={engine === 'playwright'}
              onChange={() => setEngine('playwright')}
            />{' '}
            playwright (E2E)
          </label>
          <label>
            <input
              type="radio"
              name="engine"
              checked={engine === 'k6'}
              onChange={() => setEngine('k6')}
            />{' '}
            k6 (load)
          </label>
        </div>
      </div>

      <div className={styles.field}>
        <span>Flows (none selected = all eligible)</span>
        <div className={styles.flows}>
          {eligibleFlows.length === 0 && <span className="muted">No flows support {engine}.</span>}
          {eligibleFlows.map((f) => (
            <label key={f.id} className={styles.flow}>
              <input
                type="checkbox"
                checked={selectedFlows.includes(f.name)}
                onChange={() => toggleFlow(f.name)}
              />
              {f.name}
            </label>
          ))}
        </div>
      </div>

      {engine === 'k6' && (
        <label className={styles.field}>
          <span>Profile</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value as typeof profile)}>
            <option value="smoke">smoke</option>
            <option value="load">load</option>
            <option value="stress">stress</option>
          </select>
        </label>
      )}

      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || !environmentId || eligibleFlows.length === 0}
        onClick={trigger}
      >
        Trigger run
      </button>
    </div>
  )
}
