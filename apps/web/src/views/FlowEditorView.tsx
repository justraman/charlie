import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { StepEditor } from '@/components/StepEditor'
import { ApiError, api } from '@/lib/api'
import { deserializeStep, type EditableStep, makeStep, serializeStep } from '@/lib/steps'
import styles from './FlowEditorView.module.css'

type Profile = '' | 'smoke' | 'load' | 'stress'

export function FlowEditorView() {
  const params = useParams<{ projectId?: string; id?: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId
  const flowId = params.id
  const isEdit = !!flowId

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [engines, setEngines] = useState<string[]>(['playwright'])
  const [profile, setProfile] = useState<Profile>('')
  const [steps, setSteps] = useState<EditableStep[]>([makeStep('goto')])
  const [backTo, setBackTo] = useState('/projects')
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isEdit) {
      setBackTo(`/projects/${projectId}`)
      return
    }
    ;(async () => {
      try {
        const res = await api.get<{
          flow: { name: string; description: string | null; engines: string[]; projectId: string }
          currentVersion: {
            steps: Record<string, unknown>[]
            loadProfile: { profile?: string } | null
          } | null
        }>(`/api/flows/${flowId}`)
        setName(res.flow.name)
        setDescription(res.flow.description ?? '')
        setEngines(res.flow.engines)
        setBackTo(`/projects/${res.flow.projectId}`)
        if (res.currentVersion) {
          setSteps(res.currentVersion.steps.map(deserializeStep))
          setProfile((res.currentVersion.loadProfile?.profile as Profile) ?? '')
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err))
      }
    })()
  }, [isEdit, flowId, projectId])

  function toggleEngine(e: string) {
    setEngines((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]))
  }

  async function save() {
    setBusy(true)
    setError(null)
    setDetails(null)
    const payloadSteps = steps.map(serializeStep)
    const loadProfile = profile ? { profile } : null
    try {
      if (isEdit) {
        await api.put(`/api/flows/${flowId}`, {
          steps: payloadSteps,
          description: description.trim() || null,
          engines,
          loadProfile,
        })
        navigate(backTo)
      } else {
        await api.post(`/api/projects/${projectId}/flows`, {
          name: name.trim(),
          description: description.trim() || undefined,
          engines,
          steps: payloadSteps,
          loadProfile,
        })
        navigate(`/projects/${projectId}`)
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
        setDetails(err.details)
      } else {
        setError(String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const canSave =
    !busy && engines.length > 0 && steps.length > 0 && (isEdit || name.trim().length > 0)

  return (
    <div className="container">
      <Link to={backTo} className={`muted ${styles.back}`}>
        ← Back
      </Link>
      <h1>{isEdit ? `Edit flow: ${name}` : 'New flow'}</h1>
      {isEdit && (
        <p className="muted">Saving creates a new version with a diff against the current one.</p>
      )}

      {error && <p className="error">{error}</p>}
      {details != null && (
        <pre className={`error ${styles.details}`}>{JSON.stringify(details, null, 2)}</pre>
      )}

      <div className={`card ${styles.meta}`}>
        {!isEdit && (
          <label className={styles.field}>
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout" />
          </label>
        )}
        <label className={styles.field}>
          <span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className={styles.field}>
          <span>Engines</span>
          <div className={styles.engines}>
            <label>
              <input
                type="checkbox"
                checked={engines.includes('playwright')}
                onChange={() => toggleEngine('playwright')}
              />{' '}
              playwright
            </label>
            <label>
              <input
                type="checkbox"
                checked={engines.includes('k6')}
                onChange={() => toggleEngine('k6')}
              />{' '}
              k6
            </label>
          </div>
        </div>
        <label className={styles.field}>
          <span>Load profile (k6)</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
            <option value="">none</option>
            <option value="smoke">smoke</option>
            <option value="load">load</option>
            <option value="stress">stress</option>
          </select>
        </label>
      </div>

      <h2>Steps</h2>
      <StepEditor value={steps} onChange={setSteps} />

      <div className={styles.saveBar}>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>
          {isEdit ? 'Save new version' : 'Create flow'}
        </button>
      </div>
    </div>
  )
}
