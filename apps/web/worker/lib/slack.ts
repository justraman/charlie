// Slack integration primitives: request verification, slash-command parsing,
// Block Kit result messages, and thin Slack Web API helpers. Kept free of Hono
// so the parsing/verification/formatting can be unit-tested directly.

import { constantTimeEqual } from './crypto'

const encoder = new TextEncoder()

// --- Request verification ---------------------------------------------------

function toHex(buf: ArrayBuffer): string {
  let out = ''
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Verify a Slack request: reject stale timestamps (replay guard), then compare
 * `v0=HMAC_SHA256(signing_secret, "v0:" + ts + ":" + rawBody)` in constant time
 * against `X-Slack-Signature`. `nowSec` is injectable for tests.
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined | null,
  rawBody: string,
  signature: string | undefined | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signingSecret || !timestamp || !signature?.startsWith('v0=')) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) return false // 5-minute window

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${ts}:${rawBody}`))
  return constantTimeEqual(`v0=${toHex(mac)}`, signature)
}

// --- Command parsing --------------------------------------------------------

export type SlackSub = 'run' | 'e2e' | 'load' | 'status' | 'last' | 'help'

export interface ParsedSlackCommand {
  sub: SlackSub
  project?: string
  flow?: string // flow name or "all"
  env?: string
  engine?: 'playwright' | 'k6'
  profile?: 'smoke' | 'load' | 'stress'
  runId?: string
  error?: string
}

// Grammar (see docs/SLACK.md):
//   run  <project> [flow|all] --env <env> [--engine ..] [--profile ..]
//   e2e  <project> [flow|all] --env <env>            (engine=playwright)
//   load <project> [flow|all] --env <env> [--profile ..] (engine=k6)
//   status <runId>
//   last <project> [--env <env>]
//   help
export function parseSlackCommand(text: string): ParsedSlackCommand {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { sub: 'help' }

  const sub = tokens[0]!.toLowerCase()
  const rest = tokens.slice(1)
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else {
      positionals.push(t)
    }
  }

  if (sub === 'help') return { sub: 'help' }

  if (sub === 'status') {
    const runId = positionals[0]
    if (!runId) return { sub: 'status', error: 'usage: /charlie status <runId>' }
    return { sub: 'status', runId }
  }

  if (sub === 'last') {
    const project = positionals[0]
    if (!project) return { sub: 'last', error: 'usage: /charlie last <project> [--env <env>]' }
    return { sub: 'last', project, env: flags.env }
  }

  if (sub === 'run' || sub === 'e2e' || sub === 'load') {
    const project = positionals[0]
    const flow = positionals[1] ?? 'all'
    if (!project) return { sub, error: `usage: /charlie ${sub} <project> [flow|all] --env <env>` }
    if (!flags.env) return { sub, error: `${sub} requires --env <env>` }

    let engine: 'playwright' | 'k6' | undefined
    if (sub === 'e2e') engine = 'playwright'
    else if (sub === 'load') engine = 'k6'
    else if (flags.engine === 'playwright' || flags.engine === 'k6') engine = flags.engine
    else engine = 'playwright'

    const profile =
      flags.profile === 'smoke' || flags.profile === 'load' || flags.profile === 'stress'
        ? flags.profile
        : sub === 'load'
          ? 'load'
          : 'smoke'

    return { sub, project, flow, env: flags.env, engine, profile }
  }

  return { sub: 'help', error: `unknown command: ${sub}` }
}

export const SLACK_HELP = [
  '*Charlie commands*',
  '`/charlie run <project> [flow|all] --env <env> [--engine k6|playwright] [--profile smoke|load|stress]`',
  '`/charlie e2e <project> [flow|all] --env <env>` — Playwright',
  '`/charlie load <project> [flow|all] --env <env> --profile load` — k6',
  '`/charlie status <runId>`',
  '`/charlie last <project> [--env <env>]`',
  '`/charlie help`',
].join('\n')

// --- Block Kit result message -----------------------------------------------

export interface ResultMessageInput {
  runId: string
  project: string
  environment: string
  engine: string
  profile: string
  status: string // passed | failed | cancelled
  appBaseUrl: string
  /** E2E: "3/3 flows passed" style line. */
  e2eLine?: string | null
  /** Load: threshold/percentile lines. */
  loadLines?: string[]
  reason?: string | null
}

/** Build the Block Kit blocks for a terminal run message. */
export function buildResultBlocks(input: ResultMessageInput): unknown[] {
  const icon = input.status === 'passed' ? '✅' : input.status === 'cancelled' ? '🟡' : '❌'
  const engineLabel = input.engine === 'k6' ? `k6(${input.profile})` : input.engine
  const header = `${icon} ${input.project} · ${input.environment} · ${engineLabel} — ${input.status}`

  const detail: string[] = []
  if (input.e2eLine) detail.push(input.e2eLine)
  if (input.loadLines?.length) detail.push(...input.loadLines)
  if (input.reason) detail.push(`_${input.reason}_`)

  const reportUrl = `${input.appBaseUrl.replace(/\/$/, '')}/runs/${input.runId}`
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*${header}*` } }]
  if (detail.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: detail.join('\n') } })
  }
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View report' },
        url: reportUrl,
        action_id: 'charlie_view_report',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Re-run' },
        value: input.runId,
        action_id: 'charlie_rerun',
      },
    ],
  })
  return blocks
}

// --- Slack Web API ----------------------------------------------------------

interface SlackApiResponse {
  ok: boolean
  error?: string
  [k: string]: unknown
}

export const SLACK_API_BASE = 'https://slack.com/api'

/**
 * POST to the Slack Web API with a bot token; returns the parsed JSON. `apiBase`
 * defaults to the real Slack API and exists only so local/dev can point the
 * calls at a mock (via env.SLACK_API_BASE) — production always uses the default.
 */
export async function slackApi(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  apiBase: string = SLACK_API_BASE,
): Promise<SlackApiResponse> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  return (await res.json()) as SlackApiResponse
}

/** Live connectivity check: auth.test confirms the bot token is valid and
 *  returns the workspace it belongs to. */
export async function slackAuthTest(
  botToken: string,
  apiBase?: string,
): Promise<{ ok: boolean; team: string | null; detail: string | null }> {
  try {
    const res = await slackApi(botToken, 'auth.test', {}, apiBase)
    if (res.ok) {
      const team = typeof res.team === 'string' ? res.team : null
      return { ok: true, team, detail: team }
    }
    return { ok: false, team: null, detail: res.error ?? 'auth.test failed' }
  } catch (err) {
    return { ok: false, team: null, detail: (err as Error).message }
  }
}

/** Resolve a Slack user's email via users.info (needs users:read.email scope). */
export async function usersInfoEmail(
  botToken: string,
  userId: string,
  apiBase?: string,
): Promise<string | null> {
  const res = await slackApi(botToken, 'users.info', { user: userId }, apiBase)
  if (!res.ok) return null
  const user = res.user as { profile?: { email?: string } } | undefined
  return user?.profile?.email ?? null
}

/** Post a Block Kit message to a channel. */
export async function postMessage(
  botToken: string,
  channel: string,
  blocks: unknown[],
  text: string,
  apiBase?: string,
): Promise<SlackApiResponse> {
  return slackApi(botToken, 'chat.postMessage', { channel, blocks, text }, apiBase)
}

/** Reply to a slash command's response_url (ephemeral by default). */
export async function respondUrl(
  responseUrl: string,
  text: string,
  ephemeral = true,
): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response_type: ephemeral ? 'ephemeral' : 'in_channel', text }),
  })
}
