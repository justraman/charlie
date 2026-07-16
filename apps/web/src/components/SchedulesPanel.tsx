import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { ApiError, api } from '@/lib/api'
import styles from './SchedulesPanel.module.css'

interface Env {
  id: string
  name: string
}
interface Flow {
  id: string
  name: string
  engines: string[]
}
interface Schedule {
  id: string
  environmentId: string
  flowSelection: string[]
  engine: 'playwright' | 'k6'
  profile: 'smoke' | 'load' | 'stress'
  triggerType: 'cron' | 'on_merge'
  cronExpr: string | null
  watchBranch: string | null
  enabled: boolean
  lastFiredAt: string | null
  nextDueAt: string | null
}
interface ScheduleRun {
  id: string
  status: string
  trigger: string
  engine: string
  commitSha: string | null
  queuedAt: string
}

// Named cron presets; "custom" reveals a free-text field.
const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Every 15 minutes', expr: '*/15 * * * *' },
  { label: 'Hourly', expr: '@hourly' },
  { label: 'Every 6 hours', expr: '0 */6 * * *' },
  { label: 'Daily (00:00 UTC)', expr: '@daily' },
  { label: 'Weekly (Mon 00:00 UTC)', expr: '0 0 * * 1' },
]

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

export function SchedulesPanel({ projectId }: { projectId: string }) {
  const { can } = useAuth()
  const editable = can('schedules.manage')
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [envs, setEnvs] = useState<Env[]>([])
  const [flows, setFlows] = useState<Flow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [history, setHistory] = useState<Record<string, ScheduleRun[]>>({})

  const load = useCallback(async () => {
    try {
      const [s, e, f] = await Promise.all([
        api.get<{ schedules: Schedule[] }>(`/api/schedules?project=${projectId}`),
        api.get<{ environments: Env[] }>(`/api/projects/${projectId}/environments`),
        api.get<{ flows: Flow[] }>(`/api/projects/${projectId}/flows`),
      ])
      setSchedules(s.schedules)
      setEnvs(e.environments)
      setFlows(f.flows)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? id.slice(0, 8)

  async function toggle(s: Schedule) {
    try {
      await api.patch(`/api/schedules/${s.id}`, { enabled: !s.enabled })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function remove(s: Schedule) {
    if (!confirm('Delete this schedule?')) return
    try {
      await api.delete(`/api/schedules/${s.id}`)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  async function loadHistory(id: string) {
    if (history[id]) {
      setHistory((h) => {
        const { [id]: _drop, ...rest } = h
        return rest
      })
      return
    }
    try {
      const r = await api.get<{ runs: ScheduleRun[] }>(`/api/schedules/${id}/runs`)
      setHistory((h) => ({ ...h, [id]: r.runs }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Trigger</th>
              <th>Target</th>
              <th>Next / watch</th>
              <th>Last fired</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No schedules yet.
                </td>
              </tr>
            )}
            {schedules.map((s) => (
              <>
                <tr key={s.id}>
                  <td>
                    <strong>{s.triggerType === 'cron' ? 'cron' : 'on merge'}</strong>
                    {s.triggerType === 'cron' && (
                      <div className={styles.sub}>
                        <code>{s.cronExpr}</code>
                      </div>
                    )}
                  </td>
                  <td className="muted">
                    {envName(s.environmentId)} · {s.engine}
                    {s.engine === 'k6' ? ` (${s.profile})` : ''}
                    <div className={styles.sub}>{s.flowSelection.join(', ')}</div>
                  </td>
                  <td className="muted">
                    {s.triggerType === 'cron' ? fmt(s.nextDueAt) : `branch: ${s.watchBranch}`}
                  </td>
                  <td className="muted">{fmt(s.lastFiredAt)}</td>
                  <td>
                    {editable ? (
                      <button
                        type="button"
                        className={`btn ${styles.tiny}`}
                        onClick={() => toggle(s)}
                      >
                        {s.enabled ? 'on' : 'off'}
                      </button>
                    ) : (
                      <span className={s.enabled ? styles.on : styles.off}>
                        {s.enabled ? 'on' : 'off'}
                      </span>
                    )}
                  </td>
                  <td className={styles.right}>
                    <button
                      type="button"
                      className={`btn ${styles.tiny}`}
                      onClick={() => loadHistory(s.id)}
                    >
                      History
                    </button>
                    {editable && (
                      <button
                        type="button"
                        className={`btn btn-danger ${styles.tiny}`}
                        onClick={() => remove(s)}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
                {history[s.id] && (
                  <tr key={`${s.id}-history`}>
                    <td colSpan={6}>
                      {history[s.id]!.length === 0 ? (
                        <span className="muted">No runs yet.</span>
                      ) : (
                        <ul className={styles.history}>
                          {history[s.id]!.map((r) => (
                            <li key={r.id}>
                              <Link to={`/runs/${r.id}`} className="mono">
                                {r.id.slice(0, 8)}
                              </Link>{' '}
                              <span className="muted">
                                {r.status} · {r.trigger}
                                {r.commitSha ? ` · ${r.commitSha.slice(0, 7)}` : ''} ·{' '}
                                {fmt(r.queuedAt)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {editable &&
        (showForm ? (
          <ScheduleForm
            projectId={projectId}
            envs={envs}
            flows={flows}
            onDone={async () => {
              setShowForm(false)
              await load()
            }}
            onCancel={() => setShowForm(false)}
          />
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
            New schedule
          </button>
        ))}
    </div>
  )
}

function ScheduleForm({
  projectId,
  envs,
  flows,
  onDone,
  onCancel,
}: {
  projectId: string
  envs: Env[]
  flows: Flow[]
  onDone: () => void
  onCancel: () => void
}) {
  const [triggerType, setTriggerType] = useState<'cron' | 'on_merge'>('cron')
  const [environmentId, setEnvironmentId] = useState(envs[0]?.id ?? '')
  const [engine, setEngine] = useState<'playwright' | 'k6'>('playwright')
  const [selectedFlows, setSelectedFlows] = useState<string[]>([])
  const [profile, setProfile] = useState<'smoke' | 'load' | 'stress'>('smoke')
  const [preset, setPreset] = useState(CRON_PRESETS[0]!.expr)
  const [customCron, setCustomCron] = useState('')
  const [watchBranch, setWatchBranch] = useState('main')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const eligibleFlows = flows.filter((f) => f.engines.includes(engine))
  const cronExpr = preset === 'custom' ? customCron : preset

  function toggleFlow(name: string) {
    setSelectedFlows((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/schedules', {
        projectId,
        environmentId,
        engine,
        profile,
        // Empty selection means "all eligible flows".
        flowSelection: selectedFlows.length > 0 ? selectedFlows : ['all'],
        triggerType,
        cronExpr: triggerType === 'cron' ? cronExpr : undefined,
        watchBranch: triggerType === 'on_merge' ? watchBranch : undefined,
        enabled: true,
      })
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`card ${styles.form}`}>
      {error && <p className="error">{error}</p>}
      <label className={styles.field}>
        <span>Trigger</span>
        <select
          value={triggerType}
          onChange={(e) => setTriggerType(e.target.value as 'cron' | 'on_merge')}
        >
          <option value="cron">Cron interval</option>
          <option value="on_merge">On merge to branch</option>
        </select>
      </label>

      {triggerType === 'cron' ? (
        <label className={styles.field}>
          <span>Schedule</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {CRON_PRESETS.map((p) => (
              <option key={p.expr} value={p.expr}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
          {preset === 'custom' && (
            <input
              type="text"
              placeholder="minute hour day-of-month month day-of-week"
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
            />
          )}
        </label>
      ) : (
        <label className={styles.field}>
          <span>Watch branch (on the project's source repo)</span>
          <input type="text" value={watchBranch} onChange={(e) => setWatchBranch(e.target.value)} />
        </label>
      )}

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
              name="sched-engine"
              checked={engine === 'playwright'}
              onChange={() => setEngine('playwright')}
            />{' '}
            playwright (E2E)
          </label>
          <label>
            <input
              type="radio"
              name="sched-engine"
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

      <div className={styles.actions}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !environmentId || eligibleFlows.length === 0}
          onClick={submit}
        >
          Create schedule
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
