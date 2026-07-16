import { describe, expect, test } from 'bun:test'
import {
  compileK6Scenario,
  fieldNameFromSelector,
  resolveLoadProfile,
  summarizeK6,
} from '../src/k6'
import type { FlowStep } from '../src/schema'

describe('fieldNameFromSelector', () => {
  test('prefers [name=...]', () => {
    expect(fieldNameFromSelector('input[name="email"]')).toBe('email')
    expect(fieldNameFromSelector('[name=csrf_token]')).toBe('csrf_token')
  })
  test('falls back to id, then bare word, then sanitized', () => {
    expect(fieldNameFromSelector('#password')).toBe('password')
    expect(fieldNameFromSelector('username')).toBe('username')
    expect(fieldNameFromSelector('[data-test="q ty"]')).toBe('data-test_q_ty')
  })
})

describe('compileK6Scenario', () => {
  test('goto→GET, fill+submit→POST body, extract regex→capture, waitFor ms→think-time', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/login' },
      { action: 'extract', regex: 'name="csrf" value="([^"]+)"', as: 'CSRF' },
      { action: 'fill', selector: '#email', value: '{{secrets.EMAIL}}' },
      { action: 'fill', selector: 'input[name="password"]', value: 'pw' },
      { action: 'submit', selector: 'form' },
      { action: 'waitFor', ms: 500 },
      { action: 'assert', text: 'Welcome' },
    ]
    const s = compileK6Scenario(steps, 'login')
    expect(s.name).toBe('login')
    expect(s.requests).toHaveLength(2)

    const get = s.requests[0]!
    expect(get.method).toBe('GET')
    expect(get.url).toBe('/login')
    expect(get.captures).toEqual([{ as: 'CSRF', regex: 'name="csrf" value="([^"]+)"' }])

    const post = s.requests[1]!
    expect(post.method).toBe('POST')
    expect(post.url).toBe('/login') // posts to the current page URL
    expect(post.formBody).toEqual({ email: '{{secrets.EMAIL}}', password: 'pw' })
    expect(post.thinkTimeMs).toBe(500) // waitFor(ms) → think-time on the last request
    expect(post.bodyChecks).toEqual([{ contains: 'Welcome' }]) // assert text → body check
  })

  test('click and DOM assert and selector-only extract are marked not-applicable', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/' },
      { action: 'click', selector: '[data-test=checkout]' },
      { action: 'assert', selector: '#ok', state: 'visible' },
      { action: 'extract', selector: '#token', as: 'TOK' },
      { action: 'waitFor', selector: '#spinner' },
    ]
    const s = compileK6Scenario(steps, 'checkout')
    expect(s.requests).toHaveLength(1)
    const actions = s.notApplicable.map((n) => n.action).sort()
    expect(actions).toEqual(['assert', 'click', 'extract', 'waitFor'])
  })

  test('setHeader applies to subsequent requests only', () => {
    const steps: FlowStep[] = [
      { action: 'goto', url: '/a' },
      { action: 'setHeader', name: 'X-Token', value: 'abc' },
      { action: 'goto', url: '/b' },
    ]
    const s = compileK6Scenario(steps, 'h')
    expect(s.requests[0]!.headers).toEqual({})
    expect(s.requests[1]!.headers).toEqual({ 'X-Token': 'abc' })
  })
})

describe('resolveLoadProfile', () => {
  test('returns the preset for a known profile', () => {
    const r = resolveLoadProfile('smoke')
    expect(r.profile).toBe('smoke')
    expect(r.stages.length).toBeGreaterThan(0)
    expect(r.thresholds.http_req_duration).toBeDefined()
  })

  test('flow overrides win over the preset', () => {
    const r = resolveLoadProfile('load', {
      profile: 'load',
      stages: [{ duration: '10s', target: 3 }],
      thresholds: { http_req_duration: ['p(99)<1200'] },
    })
    expect(r.stages).toEqual([{ duration: '10s', target: 3 }])
    expect(r.thresholds).toEqual({ http_req_duration: ['p(99)<1200'] })
  })

  test('empty override falls back to preset', () => {
    const preset = resolveLoadProfile('load')
    const r = resolveLoadProfile('load', { profile: 'load', stages: [], thresholds: {} })
    expect(r.stages).toEqual(preset.stages)
    expect(r.thresholds).toEqual(preset.thresholds)
  })
})

describe('summarizeK6', () => {
  const data = {
    metrics: {
      http_req_duration: {
        values: { 'p(50)': 120, 'p(95)': 640, 'p(99)': 910, med: 120 },
        thresholds: { 'p(95)<800': { ok: true } },
      },
      http_req_failed: {
        values: { rate: 0.004 },
        thresholds: { 'rate<0.01': { ok: true } },
      },
      http_reqs: { values: { count: 5000, rate: 41.6 } },
      checks: { values: { passes: 20, fails: 0 } },
    },
  }
  const thresholds = { http_req_duration: ['p(95)<800'], http_req_failed: ['rate<0.01'] }

  test('extracts percentiles, rps, error rate and passes when thresholds hold', () => {
    const s = summarizeK6(data, thresholds)
    expect(s.p50).toBe(120)
    expect(s.p95).toBe(640)
    expect(s.p99).toBe(910)
    expect(s.rps).toBe(41.6)
    expect(s.errorRate).toBe(0.004)
    expect(s.requests).toBe(5000)
    expect(s.checksPassed).toBe(20)
    expect(s.checksTotal).toBe(20)
    expect(s.passed).toBe(true)
    expect(s.thresholds).toHaveLength(2)
  })

  test('a breached threshold fails the summary and names the metric', () => {
    const breached = {
      metrics: {
        ...data.metrics,
        http_req_duration: {
          values: { 'p(95)': 1200 },
          thresholds: { 'p(95)<800': { ok: false, fails: 1 } },
        },
      },
    }
    const s = summarizeK6(breached, thresholds)
    expect(s.passed).toBe(false)
    const bad = s.thresholds.find((t) => !t.ok)
    expect(bad?.metric).toBe('http_req_duration')
    expect(bad?.expression).toBe('p(95)<800')
  })
})
