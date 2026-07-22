import { describe, expect, test } from 'bun:test'
import {
  codeSpecSchema,
  flowCreateSchema,
  flowDefinitionSchema,
  flowDraftArraySchema,
  flowDraftSchema,
  stepSchema,
} from '../src/schema'

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
      { action: 'useFlow', flowId: '0191c3e2-0000-7000-8000-000000000001' },
    ]
    for (const s of steps) expect(stepSchema.safeParse(s).success).toBe(true)
  })

  test('useFlow requires a flowId', () => {
    expect(stepSchema.safeParse({ action: 'useFlow' }).success).toBe(false)
    expect(stepSchema.safeParse({ action: 'useFlow', flowId: '' }).success).toBe(false)
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

describe('codeSpecSchema', () => {
  test('accepts a minimal spec (repo only)', () => {
    expect(codeSpecSchema.safeParse({ repo: 'acme/e2e' }).success).toBe(true)
  })

  test('accepts a full spec', () => {
    const r = codeSpecSchema.safeParse({
      repo: 'acme/e2e',
      ref: 'main',
      workingDir: 'packages/e2e',
      testFilter: 'tests/checkout.spec.ts',
      grep: '@smoke',
    })
    expect(r.success).toBe(true)
  })

  test('rejects a repo that is not owner/repo', () => {
    expect(codeSpecSchema.safeParse({ repo: 'not-a-slug' }).success).toBe(false)
    expect(codeSpecSchema.safeParse({ repo: 'a/b/c' }).success).toBe(false)
  })
})

describe('flowCreateSchema', () => {
  test('defaults kind to "steps" when omitted (backward compatible)', () => {
    const r = flowCreateSchema.safeParse({
      name: 'checkout',
      engines: ['playwright'],
      steps: [{ action: 'goto', url: '/' }],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.kind).toBe('steps')
  })

  test('accepts a code flow and defaults engines to playwright', () => {
    const r = flowCreateSchema.safeParse({
      kind: 'code',
      name: 'checkout-suite',
      code: { repo: 'acme/e2e', grep: '@smoke' },
    })
    expect(r.success).toBe(true)
    if (r.success && r.data.kind === 'code') expect(r.data.engines).toEqual(['playwright'])
  })

  test('rejects a code flow missing its code spec', () => {
    expect(flowCreateSchema.safeParse({ kind: 'code', name: 'x' }).success).toBe(false)
  })

  test('rejects a code flow that also carries steps', () => {
    const r = flowCreateSchema.safeParse({
      kind: 'code',
      name: 'x',
      code: { repo: 'a/b' },
      steps: [{ action: 'goto', url: '/' }],
    })
    expect(r.success).toBe(false)
  })
})

describe('flowDraftSchema', () => {
  test('accepts a valid AI draft with reasoning and source refs', () => {
    const r = flowDraftSchema.safeParse({
      name: 'login',
      engines: ['playwright'],
      steps: [
        { action: 'goto', url: '/login' },
        { action: 'fill', selector: 'input[name="email"]', value: '{{secrets.TEST_EMAIL}}' },
        { action: 'submit', selector: 'form' },
        { action: 'assert', selector: '[data-test=dashboard]', state: 'visible' },
      ],
      reasoning: 'Found a login form at /login with email/password fields.',
      sourceRefs: [{ file: 'src/pages/Login.tsx', route: '/login' }],
    })
    expect(r.success).toBe(true)
  })

  test('defaults engines to playwright', () => {
    const r = flowDraftSchema.parse({ name: 'x', steps: [{ action: 'goto', url: '/' }] })
    expect(r.engines).toEqual(['playwright'])
  })

  test('rejects an unknown step action (malformed model output)', () => {
    const r = flowDraftSchema.safeParse({
      name: 'x',
      steps: [{ action: 'teleport', to: '/x' }],
    })
    expect(r.success).toBe(false)
  })

  test('array validator requires at least one draft', () => {
    expect(flowDraftArraySchema.safeParse([]).success).toBe(false)
  })
})
