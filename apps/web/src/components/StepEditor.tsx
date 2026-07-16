import {
  ACTION_FIELDS,
  type EditableStep,
  makeStep,
  STEP_ACTIONS,
  type StepAction,
} from '@/lib/steps'
import styles from './StepEditor.module.css'

interface Props {
  value: EditableStep[]
  onChange: (next: EditableStep[]) => void
}

export function StepEditor({ value, onChange }: Props) {
  function replaceAt(i: number, step: EditableStep) {
    onChange(value.map((s, j) => (j === i ? step : s)))
  }

  function addStep() {
    onChange([...value, makeStep('goto')])
  }

  function removeStep(i: number) {
    onChange(value.filter((_, j) => j !== i))
  }

  function move(i: number, delta: number) {
    const j = i + delta
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    onChange(next)
  }

  function changeAction(i: number, action: StepAction) {
    replaceAt(i, makeStep(action))
  }

  function setField(i: number, key: string, val: string | boolean) {
    replaceAt(i, { ...value[i]!, [key]: val })
  }

  return (
    <div className={styles.steps}>
      {value.map((step, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered positional list
        <div key={i} className={styles.step}>
          <div className={styles.stepHead}>
            <span className={styles.idx}>{i + 1}</span>
            <select
              value={step.action}
              onChange={(e) => changeAction(i, e.target.value as StepAction)}
            >
              {STEP_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <div className={styles.stepActions}>
              <button
                type="button"
                className={`btn ${styles.tiny}`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                className={`btn ${styles.tiny}`}
                disabled={i === value.length - 1}
                onClick={() => move(i, 1)}
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                className={`btn ${styles.tiny} btn-danger`}
                onClick={() => removeStep(i)}
                title="Remove"
              >
                ✕
              </button>
            </div>
          </div>
          <div className={styles.fields}>
            {ACTION_FIELDS[step.action].map((f) => {
              const fieldId = `step-${i}-${f.key}`
              return (
                <label key={f.key} className={styles.field} htmlFor={fieldId}>
                  <span>{f.label}</span>
                  {f.type === 'select' ? (
                    <select
                      id={fieldId}
                      value={(step[f.key] as string) ?? ''}
                      onChange={(e) => setField(i, f.key, e.target.value)}
                    >
                      {f.options?.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt || '—'}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={fieldId}
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={(step[f.key] as string) ?? ''}
                      placeholder={f.placeholder}
                      onChange={(e) => setField(i, f.key, e.target.value)}
                    />
                  )}
                </label>
              )
            })}
            <label className={`${styles.field} ${styles.capture}`}>
              <input
                type="checkbox"
                checked={step.captureOnFail === true}
                onChange={(e) => setField(i, 'captureOnFail', e.target.checked)}
              />
              <span>Capture screenshot/trace on failure</span>
            </label>
          </div>
        </div>
      ))}

      <button type="button" className="btn" onClick={addStep}>
        + Add step
      </button>
    </div>
  )
}
