import { beforeEach, describe, expect, test } from 'bun:test'
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from 'jose'
import type { Env } from '../worker/env'
import {
  _clearTokenCache,
  cancelWorkflowRun,
  createAppJwt,
  dispatchWorkflow,
  getInstallationToken,
  githubConfigured,
  resolveRunId,
} from '../worker/lib/github'

let privateKeyPem = ''
beforeEach(async () => {
  _clearTokenCache()
  if (!privateKeyPem) {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true })
    privateKeyPem = await exportPKCS8(privateKey)
  }
})

function testEnv(): Env {
  return {
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_INSTALLATION_ID: '987',
    GITHUB_RUNNER_REPO: 'acme/charlie-runner',
  } as unknown as Env
}

interface Recorded {
  url: string
  method: string
  body?: unknown
}

// Build a fetch mock that routes by URL substring and records calls.
function mockFetch(routes: Array<[string, () => Response]>) {
  const calls: Recorded[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const match = routes.find(([frag]) => url.includes(frag))
    if (!match) return new Response('no route', { status: 404 })
    return match[1]()
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const tokenRoute: [string, () => Response] = [
  '/access_tokens',
  () =>
    new Response(
      JSON.stringify({ token: 'ghs_installation_token', expires_at: '2999-01-01T00:00:00Z' }),
      { status: 201 },
    ),
]

describe('githubConfigured', () => {
  test('true only when all required fields present', () => {
    expect(githubConfigured(testEnv())).toBe(true)
    expect(githubConfigured({} as Env)).toBe(false)
  })
})

describe('createAppJwt', () => {
  test('is an RS256 JWT issued by the app id', async () => {
    const jwt = await createAppJwt('123456', privateKeyPem, Date.now())
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256')
    const payload = decodeJwt(jwt)
    expect(payload.iss).toBe('123456')
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600)
  })
})

describe('getInstallationToken', () => {
  test('mints then caches the token', async () => {
    const { fetchImpl, calls } = mockFetch([tokenRoute])
    const env = testEnv()
    expect(await getInstallationToken(env, { fetchImpl })).toBe('ghs_installation_token')
    expect(await getInstallationToken(env, { fetchImpl })).toBe('ghs_installation_token')
    // Second call served from cache → only one network mint.
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(1)
  })
})

describe('dispatchWorkflow', () => {
  test('posts ref + inputs to the workflow dispatch endpoint', async () => {
    const { fetchImpl, calls } = mockFetch([
      tokenRoute,
      ['/dispatches', () => new Response(null, { status: 204 })],
    ])
    await dispatchWorkflow(testEnv(), { runId: 'run_1', shards: '2' }, { fetchImpl })
    const dispatch = calls.find((c) => c.url.includes('/dispatches'))!
    expect(dispatch.url).toContain(
      '/repos/acme/charlie-runner/actions/workflows/charlie-run.yml/dispatches',
    )
    expect(dispatch.method).toBe('POST')
    expect((dispatch.body as { inputs: Record<string, string> }).inputs.runId).toBe('run_1')
    expect((dispatch.body as { ref: string }).ref).toBe('main')
  })

  test('throws on non-204', async () => {
    const { fetchImpl } = mockFetch([
      tokenRoute,
      ['/dispatches', () => new Response('bad', { status: 422 })],
    ])
    await expect(dispatchWorkflow(testEnv(), {}, { fetchImpl })).rejects.toThrow(/422/)
  })
})

describe('resolveRunId', () => {
  test('matches a run whose name embeds the runId', async () => {
    const { fetchImpl } = mockFetch([
      tokenRoute,
      [
        '/runs?event=workflow_dispatch',
        () =>
          new Response(
            JSON.stringify({
              workflow_runs: [
                { id: 111, name: 'other', created_at: '2020-01-01T00:00:00Z' },
                { id: 222, name: 'charlie-run:run_xyz', created_at: '2020-01-01T00:01:00Z' },
              ],
            }),
            { status: 200 },
          ),
      ],
    ])
    const id = await resolveRunId(
      testEnv(),
      { runId: 'run_xyz', sinceIso: '2020-01-01T00:00:00Z' },
      { fetchImpl },
    )
    expect(id).toBe('222')
  })
})

describe('cancelWorkflowRun', () => {
  test('returns true on 202', async () => {
    const { fetchImpl } = mockFetch([
      tokenRoute,
      ['/cancel', () => new Response(null, { status: 202 })],
    ])
    expect(await cancelWorkflowRun(testEnv(), '222', { fetchImpl })).toBe(true)
  })
})
