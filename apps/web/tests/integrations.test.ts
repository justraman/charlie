import { describe, expect, test } from 'bun:test'
import type { Env } from '../worker/env'
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
