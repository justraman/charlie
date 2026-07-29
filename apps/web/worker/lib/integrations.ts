// Integration configuration is sourced from env (Cloudflare secrets), never the
// DB. This module exposes the Slack credential helpers and the consolidated
// live-status used by the Integrations page. Each "connected" flag comes from a
// real connectivity check (Slack auth.test, GitHub token mint), cached briefly
// in KV so the page stays responsive and we don't hammer APIs.

import type { Env } from '../env'
import { githubCheck, githubConfigured } from './github'
import { slackAuthTest } from './slack'

export interface SlackCredentials {
  botToken: string
  signingSecret: string
  teamId: string | null
}

/** Whether Slack is configured via env (bot token + signing secret present). */
export function slackConfigured(env: Env): boolean {
  return Boolean(env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET)
}

/** Slack credentials from env, or null if not configured. */
export function slackCredentials(env: Env): SlackCredentials | null {
  if (!slackConfigured(env)) return null
  return {
    botToken: env.SLACK_BOT_TOKEN!,
    signingSecret: env.SLACK_SIGNING_SECRET!,
    teamId: env.SLACK_TEAM_ID ?? null,
  }
}

export interface IntegrationStatus {
  configured: boolean
  connected: boolean
  detail: string | null
}
export interface IntegrationsStatus {
  slack: IntegrationStatus
  github: IntegrationStatus
  checkedAt: string
}

// v2: the AI-provider entry was removed from the payload — bump so a cached v1
// blob isn't served to the new page shape.
const STATUS_KV_KEY = 'intstatus:v2'
const STATUS_TTL_SEC = 60

/**
 * Consolidated live status for the Integrations page. Cached in KV for
 * STATUS_TTL_SEC; `refresh` bypasses the cache and rewrites it. Live checks run
 * in parallel and are skipped (connected:false) when the integration is not
 * configured.
 */
export async function getIntegrationsStatus(
  env: Env,
  opts: { refresh?: boolean } = {},
): Promise<IntegrationsStatus> {
  if (!opts.refresh) {
    const cached = await env.KV.get(STATUS_KV_KEY)
    if (cached) {
      try {
        return JSON.parse(cached) as IntegrationsStatus
      } catch {
        // fall through and recompute
      }
    }
  }

  const [slackChk, githubChk] = await Promise.all([
    slackConfigured(env)
      ? slackAuthTest(env.SLACK_BOT_TOKEN!, env.SLACK_API_BASE)
      : Promise.resolve({ ok: false, detail: null as string | null }),
    githubCheck(env),
  ])

  const status: IntegrationsStatus = {
    slack: {
      configured: slackConfigured(env),
      connected: slackChk.ok,
      detail: slackChk.detail,
    },
    github: {
      configured: githubConfigured(env),
      connected: githubChk.ok,
      detail: githubChk.detail,
    },
    checkedAt: new Date().toISOString(),
  }

  await env.KV.put(STATUS_KV_KEY, JSON.stringify(status), { expirationTtl: STATUS_TTL_SEC })
  return status
}
