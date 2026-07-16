import { describe, expect, test } from 'bun:test'
import type { AssertResult, EngineAdapter, StepEvent } from '../src/executor'
import { executeFlow } from '../src/executor'
import type { FlowStep } from '../src/schema'

// A recording fake adapter. assertResults lets a test script per-call outcomes.
function fakeAdapter(overrides: Partial<EngineAdapter> = {}): {
  adapter: EngineAdapter
  calls: string[]
} {
  const calls: string[] = []
  const adapter: EngineAdapter = {
    async goto(url) {
      calls.push(`goto ${url}`)
    },
    async click(sel) {
      calls.push(`click ${sel}`)
    },
    async fill(sel, val) {
      calls.push(`fill ${sel}=${val}`)
    },
    async waitFor(t) {
      calls.push(`waitFor ${JSON.stringify(t)}`)
    },
    async assert(): Promise<AssertResult> {
      calls.push('assert')
      return { ok: true }
    },
    async extract() {
      calls.push('extract')
      return 'extracted-value'
    },
    async submit(sel) {
      calls.push(`submit ${sel}`)
    },
    async setHeader(n, v) {
      calls.push(`setHeader ${n}=${v}`)
    },
    async captureArtifacts(reason) {
      calls.push(`capture ${reason}`)
      return { screenshot: 'shot.png' }
    },
    ...overrides,
  }
  return { adapter, calls }
}

const clock = () => {
  let t = 0
  return () => (t += 10)
}

describe('executeFlow', () => {
  test('runs every step and resolves secrets/vars', async () => {
    const { adapter, calls } = fakeAdapter()
    const steps: FlowStep[] = [
      { action: 'goto', url: '/start' },
      { action: 'fill', selector: '#email', value: '{{secrets.EMAIL}}' },
      { action: 'extract', selector: '#csrf', as: 'csrf' },
      { action: 'setHeader', name: 'X-CSRF', value: '{{vars.csrf}}' },
    ]
    const result = await executeFlow(
      steps,
      { adapter, secrets: { EMAIL: 'qa@example.com' }, vars: {} },
      { now: clock() },
    )
    expect(result.status).toBe('passed')
    expect(result.vars.csrf).toBe('extracted-value')
    expect(calls).toEqual([
      'goto /start',
      'fill #email=qa@example.com',
      'extract',
      'setHeader X-CSRF=extracted-value',
    ])
    expect(result.steps.every((s) => s.status === 'passed')).toBe(true)
  })

  test('stops at the first failing step and reports it', async () => {
    const { adapter } = fakeAdapter({
      async assert() {
        return { ok: false, detail: 'element not visible' }
      },
    })
    const steps: FlowStep[] = [
      { action: 'goto', url: '/' },
      { action: 'assert', selector: '#x', state: 'visible' },
      { action: 'click', selector: '#never' },
    ]
    const result = await executeFlow(steps, { adapter, secrets: {}, vars: {} }, { now: clock() })
    expect(result.status).toBe('failed')
    expect(result.failedStepIndex).toBe(1)
    expect(result.steps).toHaveLength(2) // stopped before the click
    expect(result.steps[1]!.error).toBe('element not visible')
  })

  test('captureOnFail triggers artifact capture', async () => {
    const { adapter, calls } = fakeAdapter({
      async click() {
        throw new Error('boom')
      },
    })
    const steps: FlowStep[] = [{ action: 'click', selector: '#x', captureOnFail: true }]
    const result = await executeFlow(steps, { adapter, secrets: {}, vars: {} }, { now: clock() })
    expect(result.status).toBe('failed')
    expect(result.steps[0]!.artifacts).toEqual({ screenshot: 'shot.png' })
    expect(calls).toContain('capture boom')
  })

  test('emits step-start/step-end/error events', async () => {
    const { adapter } = fakeAdapter()
    const events: StepEvent[] = []
    await executeFlow(
      [{ action: 'goto', url: '/' }],
      { adapter, secrets: {}, vars: {} },
      { now: clock(), emit: (e) => events.push(e) },
    )
    expect(events.map((e) => e.type)).toEqual(['step-start', 'step-end'])
    expect(events[1]!.status).toBe('passed')
  })
})
