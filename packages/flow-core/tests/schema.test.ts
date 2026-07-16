import { describe, expect, test } from 'bun:test'
import { flowDefinitionSchema, stepSchema } from '../src/schema'

describe('stepSchema', () => {
  test('accepts each valid action', () => {
    const steps = [
      { action: 'goto', url: '/products/42' },
      { action: 'click', selector: '#buy' },
      { action: 'fill', selector: '#email', value: '{{secrets.TEST_EMAIL}}' },
      { action: 'waitFor', selector: '#loaded' },
      { action: 'waitFor', ms: 500 },
      { action: 'assert', selector: '#ok', state: 'visible' },
      { action: 'assert', text: 'Welcome' },
      { action: 'extract', selector: '#csrf', as: 'csrf' },
      { action: 'submit', selector: 'form' },
      { action: 'setHeader', name: 'X-Test', value: '1' },
    ]
    for (const s of steps) expect(stepSchema.safeParse(s).success).toBe(true)
  })

  test('rejects an unknown action', () => {
    expect(stepSchema.safeParse({ action: 'teleport', url: '/x' }).success).toBe(false)
  })

  test('rejects unknown fields (strict)', () => {
    expect(stepSchema.safeParse({ action: 'goto', url: '/x', wat: 1 }).success).toBe(false)
  })

  test('waitFor requires selector or ms', () => {
    expect(stepSchema.safeParse({ action: 'waitFor' }).success).toBe(false)
  })

  test('assert requires selector+state or text', () => {
    expect(stepSchema.safeParse({ action: 'assert', selector: '#x' }).success).toBe(false)
    expect(
      stepSchema.safeParse({ action: 'assert', selector: '#x', state: 'visible' }).success,
    ).toBe(true)
  })

  test('extract `as` must be a valid variable name', () => {
    expect(stepSchema.safeParse({ action: 'extract', selector: '#x', as: '1bad' }).success).toBe(
      false,
    )
    expect(stepSchema.safeParse({ action: 'extract', selector: '#x', as: 'good_1' }).success).toBe(
      true,
    )
  })
})

describe('flowDefinitionSchema', () => {
  test('accepts a complete flow with load profile', () => {
    const result = flowDefinitionSchema.safeParse({
      name: 'checkout',
      description: 'guest checkout',
      engines: ['playwright', 'k6'],
      steps: [{ action: 'goto', url: '/' }],
      loadProfile: {
        profile: 'load',
        stages: [{ duration: '30s', target: 50 }],
        thresholds: { http_req_duration: ['p(95)<800'] },
      },
    })
    expect(result.success).toBe(true)
  })

  test('requires at least one engine and one step', () => {
    expect(flowDefinitionSchema.safeParse({ name: 'x', engines: [], steps: [] }).success).toBe(
      false,
    )
  })

  test('rejects a bad k6 duration', () => {
    const result = flowDefinitionSchema.safeParse({
      name: 'x',
      engines: ['k6'],
      steps: [{ action: 'goto', url: '/' }],
      loadProfile: { profile: 'load', stages: [{ duration: '30sec', target: 1 }] },
    })
    expect(result.success).toBe(false)
  })
})
