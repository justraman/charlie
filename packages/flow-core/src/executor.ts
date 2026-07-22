// Shared, engine-agnostic step executor. Both engines (Playwright in Phase 3,
// k6 in Phase 4) implement the EngineAdapter; the executor iterates steps,
// resolves placeholders, dispatches to the actionRegistry, threads extracted
// vars forward, and emits structured events. Adding an action means adding one
// handler here — not editing both engines.

import { resolvePlaceholders, resolveStepPlaceholders } from './placeholders'
import type { FlowStep, StepAction } from './schema'

export interface WaitTarget {
  selector?: string
  ms?: number
}

export interface AssertSpec {
  selector?: string
  state?: string
  text?: string
}

export interface AssertResult {
  ok: boolean
  detail?: string
}

export interface ExtractSpec {
  selector?: string
  regex?: string
}

export interface ArtifactRefs {
  [name: string]: string
}

/** Implemented per engine. The executor calls only through this surface. */
export interface EngineAdapter {
  goto(url: string): Promise<void>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  waitFor(target: WaitTarget): Promise<void>
  assert(check: AssertSpec): Promise<AssertResult>
  extract(spec: ExtractSpec): Promise<string>
  submit(selector: string): Promise<void>
  setHeader(name: string, value: string): Promise<void>
  captureArtifacts(reason: string): Promise<ArtifactRefs>
}

export type StepStatus = 'passed' | 'failed'

export interface StepEvent {
  type: 'step-start' | 'step-end' | 'error'
  index: number
  action: StepAction
  label?: string
  durationMs?: number
  status?: StepStatus
  error?: string
  artifacts?: ArtifactRefs
}

export type EventSink = (event: StepEvent) => void

export interface ExecuteContext {
  adapter: EngineAdapter
  secrets: Record<string, string>
  vars: Record<string, string>
}

export interface StepResult {
  index: number
  action: StepAction
  label?: string
  status: StepStatus
  durationMs: number
  error?: string
  artifacts?: ArtifactRefs
}

export interface FlowRunResult {
  status: StepStatus
  steps: StepResult[]
  vars: Record<string, string>
  failedStepIndex?: number
}

class StepFailure extends Error {}

type ActionHandler = (step: FlowStep, ctx: ExecuteContext) => Promise<void>

// One handler per action. Handlers receive the placeholder-resolved step.
export const actionRegistry: Record<StepAction, ActionHandler> = {
  async goto(step, ctx) {
    if (step.action !== 'goto') return
    await ctx.adapter.goto(step.url)
  },
  async click(step, ctx) {
    if (step.action !== 'click') return
    await ctx.adapter.click(step.selector)
  },
  async fill(step, ctx) {
    if (step.action !== 'fill') return
    await ctx.adapter.fill(step.selector, step.value)
  },
  async waitFor(step, ctx) {
    if (step.action !== 'waitFor') return
    await ctx.adapter.waitFor({ selector: step.selector, ms: step.ms })
  },
  async assert(step, ctx) {
    if (step.action !== 'assert') return
    const result = await ctx.adapter.assert({
      selector: step.selector,
      state: step.state,
      text: step.text,
    })
    if (!result.ok) throw new StepFailure(result.detail ?? 'assertion failed')
  },
  async extract(step, ctx) {
    if (step.action !== 'extract') return
    const value = await ctx.adapter.extract({ selector: step.selector, regex: step.regex })
    ctx.vars[step.as] = value
  },
  async submit(step, ctx) {
    if (step.action !== 'submit') return
    await ctx.adapter.submit(step.selector)
  },
  async setHeader(step, ctx) {
    if (step.action !== 'setHeader') return
    await ctx.adapter.setHeader(step.name, step.value)
  },
  // `useFlow` is a compile-time reference: the control plane inlines the
  // referenced flow's steps into the run bundle, so a well-formed run never
  // reaches here. Reaching it means an unexpanded reference slipped through.
  async useFlow(step) {
    if (step.action !== 'useFlow') return
    throw new Error(
      `useFlow (flow ${step.flowId}) was not expanded before execution — this is a bug`,
    )
  },
}

/**
 * Execute a flow's steps against an engine adapter. Stops at the first failing
 * step (E2E semantics: a flow passes only if every step passes). `now` is
 * injectable so callers can supply a monotonic clock.
 */
export async function executeFlow(
  steps: FlowStep[],
  ctx: ExecuteContext,
  options: { emit?: EventSink; now?: () => number } = {},
): Promise<FlowRunResult> {
  const emit = options.emit ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const results: StepResult[] = []
  let overall: StepStatus = 'passed'
  let failedStepIndex: number | undefined

  for (let index = 0; index < steps.length; index++) {
    const raw = steps[index]!
    // `vars` grows as extract steps run, so resolve per step.
    const step = resolveStepPlaceholders(raw, { secrets: ctx.secrets, vars: ctx.vars })
    emit({ type: 'step-start', index, action: step.action, label: step.label })

    const startedAt = now()
    try {
      await actionRegistry[step.action](step, ctx)
      const durationMs = now() - startedAt
      results.push({ index, action: step.action, label: step.label, status: 'passed', durationMs })
      emit({
        type: 'step-end',
        index,
        action: step.action,
        label: step.label,
        durationMs,
        status: 'passed',
      })
    } catch (err) {
      const durationMs = now() - startedAt
      const message = err instanceof Error ? err.message : String(err)
      let artifacts: ArtifactRefs | undefined
      if (raw.captureOnFail) {
        try {
          artifacts = await ctx.adapter.captureArtifacts(message)
        } catch {
          // capture is best-effort; never mask the original failure
        }
      }
      results.push({
        index,
        action: step.action,
        label: step.label,
        status: 'failed',
        durationMs,
        error: message,
        artifacts,
      })
      emit({
        type: 'error',
        index,
        action: step.action,
        label: step.label,
        durationMs,
        status: 'failed',
        error: message,
        artifacts,
      })
      overall = 'failed'
      failedStepIndex = index
      break
    }
  }

  return { status: overall, steps: results, vars: ctx.vars, failedStepIndex }
}

// Re-exported for engines that need to resolve a lone string (e.g. base_url join).
export { resolvePlaceholders }
