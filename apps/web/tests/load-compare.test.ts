import { describe, expect, test } from 'bun:test'
import { compareLoad, type LoadMetrics } from '../worker/lib/load-compare'

const current: LoadMetrics = { p50: 120, p95: 180, p99: 240, rps: 44, errorRate: 0.004 }

describe('compareLoad', () => {
  test('lower latency and error rate count as improvements; higher rps too', () => {
    const c = compareLoad(current, {
      runId: 'prev',
      at: '2026-07-22T00:00:00.000Z',
      metrics: { p50: 150, p95: 200, p99: 240, rps: 40, errorRate: 0.008 },
    })
    expect(c.baselineRunId).toBe('prev')
    // p95 dropped 200 → 180 = -10%, and lower latency is better.
    expect(c.p95.deltaPct).toBeCloseTo(-10, 5)
    expect(c.p95.better).toBe(true)
    // error rate halved → better.
    expect(c.errorRate.better).toBe(true)
    // rps up 40 → 44 = +10%, higher is better.
    expect(c.rps.deltaPct).toBeCloseTo(10, 5)
    expect(c.rps.better).toBe(true)
  })

  test('higher latency is a degradation', () => {
    const c = compareLoad(current, {
      runId: 'prev',
      at: null,
      metrics: { p50: 100, p95: 150, p99: 200, rps: 50, errorRate: 0.002 },
    })
    expect(c.p95.deltaPct).toBeCloseTo(20, 5) // 150 → 180
    expect(c.p95.better).toBe(false)
    // rps dropped 50 → 44 → worse.
    expect(c.rps.better).toBe(false)
  })

  test('no change yields better=null; missing/zero baseline yields null delta', () => {
    const c = compareLoad(current, {
      runId: 'prev',
      at: null,
      metrics: { p50: 120, p95: 180, p99: null, rps: 0, errorRate: null },
    })
    expect(c.p95.deltaPct).toBe(0)
    expect(c.p95.better).toBeNull()
    expect(c.p99.deltaPct).toBeNull() // baseline null
    expect(c.rps.deltaPct).toBeNull() // baseline zero (avoid /0)
    expect(c.errorRate.deltaPct).toBeNull()
  })
})
