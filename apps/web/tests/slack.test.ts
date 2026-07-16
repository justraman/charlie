import { describe, expect, test } from 'bun:test'
import { buildResultBlocks, parseSlackCommand, verifySlackSignature } from '../worker/lib/slack'

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

describe('buildResultBlocks', () => {
  test('passed run has a header and a View report url button', () => {
    const blocks = buildResultBlocks({
      runId: 'run1',
      project: 'demo',
      environment: 'qa',
      engine: 'playwright',
      profile: 'smoke',
      status: 'passed',
      appBaseUrl: 'https://charlie.example.com',
      e2eLine: '3/3 flows passed',
    }) as { type: string; text?: { text: string }; elements?: { url?: string }[] }[]
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain('✅')
    expect(header.text.text).toContain('demo · qa · playwright — passed')
    const actions = blocks.find((b) => b.type === 'actions')!
    expect(actions.elements?.[0]?.url).toBe('https://charlie.example.com/runs/run1')
  })

  test('failed load run lists the breached threshold lines', () => {
    const blocks = buildResultBlocks({
      runId: 'run2',
      project: 'demo',
      environment: 'staging',
      engine: 'k6',
      profile: 'load',
      status: 'failed',
      appBaseUrl: 'https://c.example.com/',
      loadLines: ['p95 1900ms (threshold p(95)<800)', 'error rate 4.2%'],
    }) as { type: string; text?: { text: string } }[]
    const header = blocks[0] as { text: { text: string } }
    expect(header.text.text).toContain('❌')
    expect(header.text.text).toContain('k6(load)')
    const body = blocks[1] as { text: { text: string } }
    expect(body.text.text).toContain('p95 1900ms')
  })
})
