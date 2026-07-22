// Editor-side metadata for the flow step types. The canonical schema lives in
// @charlie/flow-core; this drives the form UI and serialization back to the
// wire shape the API validates.

export const STEP_ACTIONS = [
  'goto',
  'click',
  'fill',
  'waitFor',
  'assert',
  'extract',
  'submit',
  'setHeader',
  'useFlow',
] as const
export type StepAction = (typeof STEP_ACTIONS)[number]

export interface FieldDef {
  key: string
  label: string
  // 'flow' renders a picker of the project's other steps flows (dynamic options).
  type: 'text' | 'number' | 'select' | 'flow'
  options?: string[]
  placeholder?: string
}

export const ACTION_FIELDS: Record<StepAction, FieldDef[]> = {
  goto: [{ key: 'url', label: 'URL', type: 'text', placeholder: '/path or https://…' }],
  click: [{ key: 'selector', label: 'Selector', type: 'text', placeholder: '[data-test=buy]' }],
  fill: [
    { key: 'selector', label: 'Selector', type: 'text', placeholder: '#email' },
    { key: 'value', label: 'Value', type: 'text', placeholder: '{{secrets.TEST_EMAIL}}' },
  ],
  waitFor: [
    { key: 'selector', label: 'Selector (optional)', type: 'text', placeholder: '#loaded' },
    { key: 'ms', label: 'Milliseconds (optional)', type: 'number', placeholder: '500' },
  ],
  assert: [
    { key: 'selector', label: 'Selector', type: 'text', placeholder: '#confirmation' },
    {
      key: 'state',
      label: 'State',
      type: 'select',
      options: ['', 'visible', 'hidden', 'attached', 'detached'],
    },
    { key: 'text', label: 'Text (optional)', type: 'text', placeholder: 'Order confirmed' },
  ],
  extract: [
    { key: 'selector', label: 'Selector', type: 'text', placeholder: 'input[name=csrf]' },
    { key: 'regex', label: 'Regex (optional)', type: 'text' },
    { key: 'as', label: 'Bind as var', type: 'text', placeholder: 'csrf' },
  ],
  submit: [{ key: 'selector', label: 'Form selector', type: 'text', placeholder: 'form#checkout' }],
  setHeader: [
    { key: 'name', label: 'Header name', type: 'text', placeholder: 'Authorization' },
    { key: 'value', label: 'Header value', type: 'text', placeholder: 'Bearer {{secrets.TOKEN}}' },
  ],
  // Inline another flow's steps here (e.g. a shared login flow run first).
  useFlow: [{ key: 'flowId', label: 'Flow to run', type: 'flow' }],
}

// The editor holds each step as a loose string map keyed by field.
export type EditableStep = { action: StepAction; captureOnFail?: boolean } & Record<
  string,
  string | boolean | undefined
>

export function makeStep(action: StepAction): EditableStep {
  const step: EditableStep = { action }
  for (const f of ACTION_FIELDS[action]) step[f.key] = ''
  return step
}

/** Convert an editor step to the wire shape, dropping empty optional fields. */
export function serializeStep(step: EditableStep): Record<string, unknown> {
  const out: Record<string, unknown> = { action: step.action }
  for (const f of ACTION_FIELDS[step.action]) {
    const v = step[f.key]
    if (v === undefined || v === '' || v === null) continue
    out[f.key] = f.type === 'number' ? Number(v) : v
  }
  if (step.captureOnFail) out.captureOnFail = true
  return out
}

/** Convert a wire step (from the API) into an editor step. */
export function deserializeStep(wire: Record<string, unknown>): EditableStep {
  const action = wire.action as StepAction
  const step = makeStep(action)
  for (const f of ACTION_FIELDS[action] ?? []) {
    if (wire[f.key] !== undefined) step[f.key] = String(wire[f.key])
  }
  if (wire.captureOnFail === true) step.captureOnFail = true
  return step
}
