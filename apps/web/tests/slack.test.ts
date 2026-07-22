import { describe, expect, test } from 'bun:test'
import {
  buildK6ReplyBlocks,
  buildK6TableText,
  buildRunParentBlocks,
  parseSlackCommand,
  runParentText,
  verifySlackSignature,
} from '../worker/lib/slack'

async function sign(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${body}`))
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `v0=${hex}`
}

describe('verifySlackSignature', () => {
  const secret = 'slack-signing-secret'
  const body = 'token=x&command=/charlie&text=run+demo'
  const now = 1_800_000_000

  test('accepts a fresh, correctly-signed request', async () => {
    const sig = await sign(secret, now, body)
    expect(await verifySlackSignature(secret, String(now), body, sig, now)).toBe(true)
  })

  test('rejects a stale timestamp (replay guard)', async () => {
    const old = now - 600 // 10 min old
    const sig = await sign(secret, old, body)
    expect(await verifySlackSignature(secret, String(old), body, sig, now)).toBe(false)
  })

  test('rejects a tampered body / wrong secret / missing header', async () => {
    const sig = await sign(secret, now, body)
    expect(await verifySlackSignature(secret, String(now), `${body}&x=1`, sig, now)).toBe(false)
    expect(await verifySlackSignature('other', String(now), body, sig, now)).toBe(false)
    expect(await verifySlackSignature(secret, String(now), body, undefined, now)).toBe(false)
  })
})

describe('parseSlackCommand', () => {
  test('run with project + env, defaults flow=all engine=playwright', () => {
    const p = parseSlackCommand('run checkout --env qa')
    expect(p).toMatchObject({
      sub: 'run',
      project: 'checkout',
      flow: 'all',
      env: 'qa',
      engine: 'playwright',
      profile: 'smoke',
    })
  })

  test('run with explicit flow, engine and profile', () => {
    const p = parseSlackCommand('run demo login --env staging --engine k6 --profile stress')
    expect(p).toMatchObject({
      sub: 'run',
      project: 'demo',
      flow: 'login',
      env: 'staging',
      engine: 'k6',
      profile: 'stress',
    })
  })

  test('load shorthand forces k6 and defaults profile=load', () => {
    const p = parseSlackCommand('load demo --env qa')
    expect(p.engine).toBe('k6')
    expect(p.profile).toBe('load')
  })

  test('e2e shorthand forces playwright', () => {
    expect(parseSlackCommand('e2e demo all --env dev').engine).toBe('playwright')
  })

  test('missing --env is an error', () => {
    expect(parseSlackCommand('run demo').error).toBeDefined()
  })

  test('status and last and help', () => {
    expect(parseSlackCommand('status abc-123')).toMatchObject({ sub: 'status', runId: 'abc-123' })
    expect(parseSlackCommand('last demo --env qa')).toMatchObject({
      sub: 'last',
      project: 'demo',
      env: 'qa',
    })
    expect(parseSlackCommand('help').sub).toBe('help')
    expect(parseSlackCommand('').sub).toBe('help')
  })
})

describe('runParentText', () => {
  const base = { flowLabel: 'checkout', project: 'demo', environment: 'qa' }
  test('started uses the hourglass and "Started flow"', () => {
    expect(runParentText({ ...base, phase: 'started' })).toBe(
      '⏳ Started flow "checkout" on demo@qa',
    )
  })
  test('passed uses green check + Completed, failed uses red circle', () => {
    expect(runParentText({ ...base, phase: 'passed' })).toBe(
      '✅ Completed flow "checkout" on demo@qa',
    )
    expect(runParentText({ ...base, phase: 'failed' })).toBe('🔴 Failed flow "checkout" on demo@qa')
  })
})

describe('buildRunParentBlocks', () => {
  const base = {
    flowLabel: 'checkout',
    project: 'demo',
    environment: 'qa',
    runId: 'run1',
    appBaseUrl: 'https://c.example.com',
  }
  test('started shows a Track progress link, no Re-run', () => {
    const blocks = buildRunParentBlocks({ ...base, phase: 'started' }) as {
      type: string
      elements?: { text?: { text: string }; url?: string; action_id?: string }[]
    }[]
    const actions = blocks.find((b) => b.type === 'actions')!
    expect(actions.elements).toHaveLength(1)
    expect(actions.elements?.[0]?.text?.text).toBe('Track progress')
    expect(actions.elements?.[0]?.url).toBe('https://c.example.com/runs/run1')
  })
  test('terminal shows View report + Re-run', () => {
    const blocks = buildRunParentBlocks({ ...base, phase: 'failed' }) as {
      type: string
      elements?: { action_id?: string }[]
    }[]
    const actions = blocks.find((b) => b.type === 'actions')!
    expect(actions.elements?.map((e) => e.action_id)).toEqual([
      'charlie_view_report',
      'charlie_rerun',
    ])
  })
})

describe('buildK6TableText', () => {
  const summary = {
    p50: 120,
    p95: 190,
    p99: 240,
    rps: 42.5,
    errorRate: 0.004,
    requests: 5100,
    checksPassed: 5090,
    checksTotal: 5100,
    thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<800', ok: true }],
  }
  test('renders aligned columns with a header row', () => {
    const table = buildK6TableText(summary)
    const lines = table.split('\n')
    expect(lines[0]).toContain('METRIC')
    expect(lines[0]).toContain('CURRENT')
    expect(lines[0]).toContain('BASELINE')
    expect(lines[0]).toContain('CHANGE')
    expect(table).toContain('p95 latency')
    expect(table).toContain('190 ms')
  })
  test('shows baseline values and signed change when a comparison is given', () => {
    const table = buildK6TableText(summary, {
      baselineRunId: 'prev',
      baselineAt: null,
      p50: { current: 120, previous: 150, deltaPct: -20, better: true },
      p95: { current: 190, previous: 170, deltaPct: 11.8, better: false },
      p99: { current: 240, previous: 240, deltaPct: 0, better: null },
      rps: { current: 42.5, previous: 40, deltaPct: 6.25, better: true },
      errorRate: { current: 0.004, previous: 0.002, deltaPct: 100, better: false },
    })
    expect(table).toContain('-20.0% better')
    expect(table).toContain('+11.8% worse')
  })
})

describe('buildK6ReplyBlocks', () => {
  const summary = {
    p50: 120,
    p95: 1900,
    p99: 2100,
    rps: 42.5,
    errorRate: 0.042,
    requests: 5100,
    checksPassed: 5000,
    checksTotal: 5100,
    thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<800', ok: false }],
  }
  test('keeps the headline lines, adds a code-block table, and notes the PDF', () => {
    const blocks = buildK6ReplyBlocks({ summary, comparison: null, hasPdf: true }) as {
      type: string
      text?: { text: string }
      elements?: { text: string }[]
    }[]
    const texts = blocks
      .map((b) => b.text?.text ?? b.elements?.map((e) => e.text).join(''))
      .join('\n')
    expect(texts).toContain('p95 1900ms')
    expect(texts).toContain('Failing threshold: http_req_duration')
    expect(texts).toContain('```') // fenced table
    expect(texts).toContain('📎')
    expect(texts).toContain('No previous run with the same settings')
  })
})
