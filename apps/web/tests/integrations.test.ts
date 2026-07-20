import { describe, expect, test } from 'bun:test'
import type { Env } from '../worker/env'
import { aiCheck, aiConfigured, resolveAiProvider } from '../worker/lib/ai'
import { slackConfigured, slackCredentials } from '../worker/lib/integrations'

function env(overrides: Partial<Env>): Env {
  return overrides as unknown as Env
}

describe('slack env helpers', () => {
  test('configured only when both bot token and signing secret present', () => {
    expect(slackConfigured(env({ SLACK_BOT_TOKEN: 'xoxb-x', SLACK_SIGNING_SECRET: 's' }))).toBe(
      true,
    )
    expect(slackConfigured(env({ SLACK_BOT_TOKEN: 'xoxb-x' }))).toBe(false)
    expect(slackConfigured(env({ SLACK_SIGNING_SECRET: 's' }))).toBe(false)
    expect(slackConfigured(env({}))).toBe(false)
  })

  test('slackCredentials returns the tuple or null', () => {
    expect(
      slackCredentials(
        env({ SLACK_BOT_TOKEN: 'xoxb-x', SLACK_SIGNING_SECRET: 's', SLACK_TEAM_ID: 'T1' }),
      ),
    ).toEqual({ botToken: 'xoxb-x', signingSecret: 's', teamId: 'T1' })
    expect(slackCredentials(env({ SLACK_BOT_TOKEN: 'xoxb-x' }))).toBeNull()
  })
})

describe('resolveAiProvider / aiConfigured', () => {
  test('anthropic/openai need api key + model', () => {
    const ok = resolveAiProvider(
      env({ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-x', AI_API_KEY: 'k' }),
    )
    expect(ok).toEqual({ name: 'anthropic', model: 'claude-x', apiKey: 'k', accountId: null })
    expect(resolveAiProvider(env({ AI_PROVIDER: 'openai', AI_MODEL: 'gpt' }))).toBeNull() // no key
    expect(resolveAiProvider(env({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k' }))).toBeNull() // no model
  })

  test('workers_ai needs api key + account id', () => {
    expect(
      resolveAiProvider(
        env({ AI_PROVIDER: 'workers_ai', AI_MODEL: 'm', AI_API_KEY: 'k', AI_ACCOUNT_ID: 'a' }),
      ),
    ).toEqual({ name: 'workers_ai', model: 'm', apiKey: 'k', accountId: 'a' })
    // missing account id
    expect(
      resolveAiProvider(env({ AI_PROVIDER: 'workers_ai', AI_MODEL: 'm', AI_API_KEY: 'k' })),
    ).toBeNull()
  })

  test('unknown provider kind or missing config → null / not configured', () => {
    expect(
      resolveAiProvider(env({ AI_PROVIDER: 'bogus', AI_MODEL: 'm', AI_API_KEY: 'k' })),
    ).toBeNull()
    expect(aiConfigured(env({}))).toBe(false)
    expect(aiConfigured(env({ AI_PROVIDER: 'anthropic', AI_MODEL: 'm', AI_API_KEY: 'k' }))).toBe(
      true,
    )
  })
})

describe('aiCheck (live connectivity, injected fetch)', () => {
  const base = env({ AI_PROVIDER: 'anthropic', AI_MODEL: 'claude-x', AI_API_KEY: 'k' })

  test('ok when the models endpoint returns 200', async () => {
    const res = await aiCheck(base, async () => new Response('{}', { status: 200 }))
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('anthropic')
  })

  test('not ok when the endpoint rejects the key', async () => {
    const res = await aiCheck(base, async () => new Response('bad key', { status: 401 }))
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('401')
  })

  test('not configured → ok:false without a network call', async () => {
    let called = false
    const res = await aiCheck(env({}), async () => {
      called = true
      return new Response('{}', { status: 200 })
    })
    expect(res.ok).toBe(false)
    expect(called).toBe(false)
    expect(res.detail).toBe('not configured')
  })

  test('sends the api key on the correct header per provider', async () => {
    let seen: Headers | undefined
    await aiCheck(base, async (_url, init) => {
      seen = new Headers(init?.headers)
      return new Response('{}', { status: 200 })
    })
    expect(seen?.get('x-api-key')).toBe('k')

    const openai = env({ AI_PROVIDER: 'openai', AI_MODEL: 'gpt', AI_API_KEY: 'k2' })
    await aiCheck(openai, async (_url, init) => {
      seen = new Headers(init?.headers)
      return new Response('{}', { status: 200 })
    })
    expect(seen?.get('authorization')).toBe('Bearer k2')
  })
})
