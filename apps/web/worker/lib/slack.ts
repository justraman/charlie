// Slack integration primitives: request verification, slash-command parsing,
// Block Kit result messages, and thin Slack Web API helpers. Kept free of Hono
// so the parsing/verification/formatting can be unit-tested directly.

import { constantTimeEqual } from './crypto'
import type { LoadComparison } from './pdf'

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

// --- Threaded run reporting -------------------------------------------------

export type RunPhase = 'started' | 'passed' | 'failed'

export interface RunParentInput {
  phase: RunPhase
  flowLabel: string
  project: string
  environment: string
  runId: string
  appBaseUrl: string
}

/** The one-line title of a run's parent thread message, per phase. Hourglass
 *  while running; green check / red circle once terminal. */
export function runParentText(input: {
  phase: RunPhase
  flowLabel: string
  project: string
  environment: string
}): string {
  const where = `${input.project}@${input.environment}`
  switch (input.phase) {
    case 'started':
      return `⏳ Started flow "${input.flowLabel}" on ${where}`
    case 'passed':
      return `✅ Completed flow "${input.flowLabel}" on ${where}`
    case 'failed':
      return `🔴 Failed flow "${input.flowLabel}" on ${where}`
  }
}

/** Blocks for the parent thread message. "started" carries a track-progress
 *  link; terminal phases carry View report + Re-run. */
export function buildRunParentBlocks(input: RunParentInput): unknown[] {
  const text = runParentText(input)
  const runUrl = `${input.appBaseUrl.replace(/\/$/, '')}/runs/${input.runId}`
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*${text}*` } }]
  const elements: unknown[] =
    input.phase === 'started'
      ? [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Track progress' },
            url: runUrl,
            action_id: 'charlie_view_report',
          },
        ]
      : [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View report' },
            url: runUrl,
            action_id: 'charlie_view_report',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Re-run' },
            value: input.runId,
            action_id: 'charlie_rerun',
          },
        ]
  blocks.push({ type: 'actions', elements })
  return blocks
}

// --- k6 results as a table --------------------------------------------------

export interface K6ReplySummary {
  p50: number | null
  p95: number | null
  p99: number | null
  rps: number | null
  errorRate: number | null
  requests: number | null
  checksPassed: number | null
  checksTotal: number | null
  thresholds: { metric: string; expression: string; ok: boolean }[]
}

const ms = (v: number | null) => (v == null ? '—' : `${Math.round(v)} ms`)
const rps = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}/s`)
const pctVal = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`)
function deltaCell(d: LoadComparison['p50'] | undefined): string {
  if (!d || d.deltaPct == null) return '—'
  const sign = d.deltaPct > 0 ? '+' : ''
  const tag = d.better == null ? '' : d.better ? ' better' : ' worse'
  return `${sign}${d.deltaPct.toFixed(1)}%${tag}`
}

/** A fixed-width text table of the headline metrics vs the baseline, meant for a
 *  Slack ``` code block ``` (Slack has no native tables). */
export function buildK6TableText(
  summary: K6ReplySummary,
  comparison?: LoadComparison | null,
): string {
  const rows: [string, string, string, string][] = [
    [
      'p50 latency',
      ms(summary.p50),
      ms(comparison?.p50.previous ?? null),
      deltaCell(comparison?.p50),
    ],
    [
      'p95 latency',
      ms(summary.p95),
      ms(comparison?.p95.previous ?? null),
      deltaCell(comparison?.p95),
    ],
    [
      'p99 latency',
      ms(summary.p99),
      ms(comparison?.p99.previous ?? null),
      deltaCell(comparison?.p99),
    ],
    [
      'requests/sec',
      rps(summary.rps),
      rps(comparison?.rps.previous ?? null),
      deltaCell(comparison?.rps),
    ],
    [
      'error rate',
      pctVal(summary.errorRate),
      pctVal(comparison?.errorRate.previous ?? null),
      deltaCell(comparison?.errorRate),
    ],
    ['total requests', summary.requests == null ? '—' : String(summary.requests), '—', '—'],
    [
      'checks passed',
      summary.checksTotal == null ? '—' : `${summary.checksPassed ?? 0}/${summary.checksTotal}`,
      '—',
      '—',
    ],
  ]
  const header: [string, string, string, string] = ['METRIC', 'CURRENT', 'BASELINE', 'CHANGE']
  const all = [header, ...rows]
  const widths = [0, 1, 2, 3].map((col) => Math.max(...all.map((r) => r[col]!.length)))
  const line = (r: [string, string, string, string]) =>
    r
      .map((cell, i) => cell.padEnd(widths[i]!))
      .join('  ')
      .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}

export interface K6ReplyInput {
  summary: K6ReplySummary
  comparison?: LoadComparison | null
  hasPdf: boolean
}

/** Threaded reply for a k6 run: the existing headline lines (kept as-is) plus a
 *  fixed-width comparison table. The PDF, when present, is uploaded separately. */
export function buildK6ReplyBlocks(input: K6ReplyInput): unknown[] {
  const { summary, comparison } = input
  const lines: string[] = []
  if (typeof summary.p95 === 'number') lines.push(`p95 ${Math.round(summary.p95)}ms`)
  if (typeof summary.errorRate === 'number')
    lines.push(`error rate ${(summary.errorRate * 100).toFixed(2)}%`)
  const breached = summary.thresholds.filter((t) => !t.ok).map((t) => t.metric)
  if (breached.length) lines.push(`Failing threshold: ${breached.join(', ')}`)

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: '*k6 load results*' } },
  ]
  if (lines.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } })
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `\`\`\`\n${buildK6TableText(summary, comparison)}\n\`\`\`` },
  })
  if (comparison) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Compared with the last run of the same settings${comparison.baselineAt ? ` (${comparison.baselineAt})` : ''}.`,
        },
      ],
    })
  } else {
    blocks.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: 'No previous run with the same settings to compare against.' },
      ],
    })
  }
  if (input.hasPdf) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '📎 Full report attached as PDF.' }],
    })
  }
  return blocks
}

export interface E2EReplyInput {
  flowsPassed: number
  flowsFailed: number
  firstFailingFlow?: string | null
  firstFailingStep?: number | null
}

/** Threaded reply for an E2E run: the flows-passed line and first failure. */
export function buildE2EReplyBlocks(input: E2EReplyInput): unknown[] {
  const total = input.flowsPassed + input.flowsFailed
  let text = `*E2E results*\n${input.flowsPassed}/${total} flows passed`
  if (input.firstFailingFlow) {
    text += `\nFirst failure: ${input.firstFailingFlow}`
    if (typeof input.firstFailingStep === 'number') text += ` (step ${input.firstFailingStep})`
  }
  return [{ type: 'section', text: { type: 'mrkdwn', text } }]
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

/** Post a Block Kit message to a channel (optionally as a threaded reply). */
export async function postMessage(
  botToken: string,
  channel: string,
  blocks: unknown[],
  text: string,
  opts: { threadTs?: string | null; apiBase?: string } = {},
): Promise<SlackApiResponse> {
  const body: Record<string, unknown> = { channel, blocks, text }
  if (opts.threadTs) body.thread_ts = opts.threadTs
  return slackApi(botToken, 'chat.postMessage', body, opts.apiBase)
}

/** Edit an existing message in place (chat.update) — used to flip the parent
 *  "Started" message to "Completed"/"Failed" when a run reaches a terminal state. */
export async function updateMessage(
  botToken: string,
  channel: string,
  ts: string,
  blocks: unknown[],
  text: string,
  apiBase?: string,
): Promise<SlackApiResponse> {
  return slackApi(botToken, 'chat.update', { channel, ts, blocks, text }, apiBase)
}

/** POST to the Slack Web API with a form-encoded body (a few endpoints — notably
 *  files.getUploadURLExternal — require this rather than JSON). */
async function slackApiForm(
  botToken: string,
  method: string,
  params: Record<string, string>,
  apiBase: string = SLACK_API_BASE,
): Promise<SlackApiResponse> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  })
  return (await res.json()) as SlackApiResponse
}

/**
 * Upload a file and share it into a channel thread using Slack's external-upload
 * flow (getUploadURLExternal → PUT/POST bytes → completeUploadExternal). Needs
 * the `files:write` scope. Best-effort: returns false on any failure so callers
 * can carry on without the attachment.
 */
export async function uploadFileToThread(
  botToken: string,
  args: {
    channel: string
    threadTs?: string | null
    filename: string
    title: string
    bytes: Uint8Array
  },
  apiBase?: string,
): Promise<boolean> {
  const getUrl = await slackApiForm(
    botToken,
    'files.getUploadURLExternal',
    { filename: args.filename, length: String(args.bytes.byteLength) },
    apiBase,
  )
  if (!getUrl.ok || typeof getUrl.upload_url !== 'string' || typeof getUrl.file_id !== 'string') {
    return false
  }

  const form = new FormData()
  form.append('file', new Blob([args.bytes as BlobPart]), args.filename)
  const up = await fetch(getUrl.upload_url as string, { method: 'POST', body: form })
  if (!up.ok) return false

  const complete = await slackApi(
    botToken,
    'files.completeUploadExternal',
    {
      files: [{ id: getUrl.file_id, title: args.title }],
      channel_id: args.channel,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    },
    apiBase,
  )
  return complete.ok === true
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
