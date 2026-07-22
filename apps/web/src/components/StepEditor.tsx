import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  ACTION_FIELDS,
  type EditableStep,
  makeStep,
  STEP_ACTIONS,
  type StepAction,
} from '@/lib/steps'

interface Props {
  value: EditableStep[]
  onChange: (next: EditableStep[]) => void
  /** Other steps flows in the project, for the `useFlow` step's picker. */
  flowOptions?: { id: string; name: string }[]
}

// Radix Select cannot use an empty-string item value, so the "none" option is
// stored as a sentinel in the trigger and mapped back to '' for the step field.
const FIELD_NONE = '__none__'

export function StepEditor({ value, onChange, flowOptions = [] }: Props) {
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
    <div className="space-y-3">
      {value.map((step, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps are an ordered positional list
        <div key={i} className="bg-muted/40 space-y-3 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <span className="bg-background flex size-6 shrink-0 items-center justify-center rounded-full border text-xs">
              {i + 1}
            </span>
            <Select value={step.action} onValueChange={(v) => changeAction(i, v as StepAction)}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STEP_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto flex gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                aria-label="Move up"
                title="Move up"
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                disabled={i === value.length - 1}
                onClick={() => move(i, 1)}
                aria-label="Move down"
                title="Move down"
              >
                <ArrowDownIcon />
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="icon-sm"
                onClick={() => removeStep(i)}
                aria-label="Remove"
                title="Remove"
              >
                <XIcon />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            {ACTION_FIELDS[step.action].map((f) => {
              const fieldId = `step-${i}-${f.key}`
              return (
                <div key={f.key} className="min-w-[200px] flex-1 space-y-2">
                  <Label htmlFor={fieldId}>{f.label}</Label>
                  {f.type === 'flow' ? (
                    <Select
                      value={((step[f.key] as string) ?? '') || FIELD_NONE}
                      onValueChange={(v) => setField(i, f.key, v === FIELD_NONE ? '' : v)}
                    >
                      <SelectTrigger id={fieldId} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={FIELD_NONE} disabled>
                          Select a flow…
                        </SelectItem>
                        {flowOptions.map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : f.type === 'select' ? (
                    <Select
                      value={((step[f.key] as string) ?? '') || FIELD_NONE}
                      onValueChange={(v) => setField(i, f.key, v === FIELD_NONE ? '' : v)}
                    >
                      <SelectTrigger id={fieldId} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {f.options?.map((opt) => (
                          <SelectItem key={opt} value={opt || FIELD_NONE}>
                            {opt || '—'}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={fieldId}
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={(step[f.key] as string) ?? ''}
                      placeholder={f.placeholder}
                      onChange={(e) => setField(i, f.key, e.target.value)}
                    />
                  )}
                </div>
              )
            })}
            <div className="flex items-center gap-2 py-2">
              <Switch
                id={`step-${i}-captureOnFail`}
                checked={step.captureOnFail === true}
                onCheckedChange={(checked) => setField(i, 'captureOnFail', checked)}
              />
              <Label htmlFor={`step-${i}-captureOnFail`} className="font-normal">
                Capture screenshot/trace on failure
              </Label>
            </div>
          </div>
        </div>
      ))}

      <Button type="button" variant="outline" onClick={addStep}>
        <PlusIcon /> Add step
      </Button>
    </div>
  )
}
