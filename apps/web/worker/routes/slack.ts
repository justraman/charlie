// Slack slash command + interactivity endpoints. Mounted at /slack (outside
// /api) — authenticated by the Slack request signature, not a session. Slack
// requires a response within 3s, so command handling acks immediately and does
// the real work asynchronously, posting the outcome via the command's
// response_url. See docs/SLACK.md.

import { Hono } from 'hono'
import { roleHasCapability } from '../../shared/roles'
import type { AppBindings, Env } from '../env'
import { writeAudit } from '../lib/audit'
import { HttpError } from '../lib/http'
import { resolveSlackIntegration, type SlackConfig } from '../lib/integrations'
import { createRun } from '../lib/run-create'
import {
  parseSlackCommand,
  respondUrl,
  SLACK_HELP,
  usersInfoEmail,
  verifySlackSignature,
} from '../lib/slack'

const slack = new Hono<AppBindings>()

interface CharlieUser {
  id: string
  role: 'viewer' | 'editor' | 'admin' | 'owner'
  email: string
}

async function userByEmail(env: Env, orgId: string, email: string): Promise<CharlieUser | null> {
  return env.DB.prepare(
    `SELECT id, role, email FROM users WHERE org_id = ? AND email = ? AND deleted_at IS NULL`,
  )
    .bind(orgId, email.toLowerCase())
    .first<CharlieUser>()
}

// Verify the request and load the org + Slack config. Returns null (caller 401s)
// on any failure. `teamId` from the body is only a lookup key; the signing
// secret is what authenticates.
async function verified(
  env: Env,
  raw: string,
  headers: { ts?: string; sig?: string; teamId: string | null },
): Promise<{ orgId: string; config: SlackConfig } | null> {
  const integration = await resolveSlackIntegration(env, headers.teamId)
  if (!integration) return null
  const ok = await verifySlackSignature(
    integration.config.signingSecret,
    headers.ts,
    raw,
    headers.sig,
  )
  return ok ? integration : null
}

// --- POST /slack/command — slash command ------------------------------------
slack.post('/command', async (c) => {
  const raw = await c.req.text()
  const form = new URLSearchParams(raw)
  const teamId = form.get('team_id')

  const integration = await verified(c.env, raw, {
    ts: c.req.header('x-slack-request-timestamp') ?? undefined,
    sig: c.req.header('x-slack-signature') ?? undefined,
    teamId,
  })
  if (!integration) throw new HttpError('unauthenticated', 'Invalid Slack signature')

  const text = form.get('text') ?? ''
  const cmd = parseSlackCommand(text)
  const userId = form.get('user_id') ?? ''
  const channelId = form.get('channel_id') ?? ''
  const responseUrl = form.get('response_url') ?? ''

  if (cmd.sub === 'help') {
    return c.json({ response_type: 'ephemeral', text: SLACK_HELP })
  }
  if (cmd.error) {
    return c.json({ response_type: 'ephemeral', text: `⚠️ ${cmd.error}` })
  }

  // status / last are quick DB reads — answer inline.
  if (cmd.sub === 'status') {
    const run = await c.env.DB.prepare(
      `SELECT status, engine, profile FROM runs WHERE id = ? AND org_id = ?`,
    )
      .bind(cmd.runId, integration.orgId)
      .first<{ status: string; engine: string; profile: string }>()
    const text = run
      ? `Run \`${cmd.runId}\`: *${run.status}* (${run.engine}${run.engine === 'k6' ? `/${run.profile}` : ''})`
      : `Run \`${cmd.runId}\` not found.`
    return c.json({ response_type: 'ephemeral', text })
  }
  if (cmd.sub === 'last') {
    const run = await c.env.DB.prepare(
      `SELECT r.id, r.status, r.engine FROM runs r
         JOIN projects p ON p.id = r.project_id
        WHERE p.org_id = ? AND (p.slug = ? OR p.id = ?) ORDER BY r.queued_at DESC LIMIT 1`,
    )
      .bind(integration.orgId, cmd.project, cmd.project)
      .first<{ id: string; status: string; engine: string }>()
    const text = run
      ? `Last run for *${cmd.project}*: \`${run.id.slice(0, 8)}\` — *${run.status}* (${run.engine})`
      : `No runs found for *${cmd.project}*.`
    return c.json({ response_type: 'ephemeral', text })
  }

  // run / e2e / load: ack now, do the work async (users.info + createRun).
  c.executionCtx.waitUntil(
    triggerFromSlack(c.env, integration, {
      cmd,
      userId,
      channelId,
      responseUrl,
    }),
  )
  return c.json({ response_type: 'ephemeral', text: '⏳ Starting run…' })
})

async function triggerFromSlack(
  env: Env,
  integration: { orgId: string; config: SlackConfig },
  ctx: {
    cmd: ReturnType<typeof parseSlackCommand>
    userId: string
    channelId: string
    responseUrl: string
  },
): Promise<void> {
  const { cmd, userId, channelId, responseUrl } = ctx
  const { botToken } = integration.config

  const email = await usersInfoEmail(botToken, userId, env.SLACK_API_BASE)
  if (!email) {
    await respondUrl(
      responseUrl,
      "I couldn't read your Slack email. Ask an admin to grant the app `users:read.email`, then try again.",
    )
    return
  }
  const user = await userByEmail(env, integration.orgId, email)
  if (!user) {
    await respondUrl(
      responseUrl,
      `No Charlie account is linked to *${email}*. Log in once at ${env.APP_BASE_URL} with Google SSO, then retry.`,
    )
    return
  }

  // Role gate — same capability the web trigger requires.
  if (!roleHasCapability(user.role, 'runs.trigger')) {
    await respondUrl(
      responseUrl,
      `Your role (*${user.role}*) can't trigger runs. Ask an admin for *editor* access.`,
    )
    await writeAudit(env.DB, {
      orgId: integration.orgId,
      actorId: user.id,
      actorKind: 'user',
      action: 'run.trigger.denied',
      entityType: 'run',
      entityId: null,
      after: { via: 'slack', role: user.role, command: cmd.sub },
    })
    return
  }

  try {
    const result = await createRun(env, {
      orgId: integration.orgId,
      project: cmd.project!,
      environment: cmd.env!,
      engine: cmd.engine!,
      profile: cmd.profile,
      flows: cmd.flow && cmd.flow !== 'all' ? [cmd.flow] : undefined,
      trigger: 'slack',
      triggeredBy: user.id,
      slackChannel: channelId || null,
      actorId: user.id,
      actorKind: 'user',
    })
    const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/runs/${result.runId}`
    await respondUrl(
      responseUrl,
      `:rocket: Queued *${cmd.engine}* run of *${cmd.flow}* on *${cmd.project}/${cmd.env}* — <${link}|track it>. I'll post the result here.`,
      false,
    )
  } catch (err) {
    const msg = err instanceof HttpError ? err.message : 'Failed to start the run.'
    await respondUrl(responseUrl, `⚠️ ${msg}`)
  }
}

// --- POST /slack/interactivity — button actions -----------------------------
slack.post('/interactivity', async (c) => {
  const raw = await c.req.text()
  const form = new URLSearchParams(raw)
  const payloadRaw = form.get('payload')
  if (!payloadRaw) throw new HttpError('bad_request', 'Missing payload')
  const payload = JSON.parse(payloadRaw) as {
    team?: { id?: string }
    user?: { id?: string }
    channel?: { id?: string }
    response_url?: string
    actions?: { action_id?: string; value?: string }[]
  }

  const integration = await verified(c.env, raw, {
    ts: c.req.header('x-slack-request-timestamp') ?? undefined,
    sig: c.req.header('x-slack-signature') ?? undefined,
    teamId: payload.team?.id ?? null,
  })
  if (!integration) throw new HttpError('unauthenticated', 'Invalid Slack signature')

  const action = payload.actions?.[0]
  if (action?.action_id === 'charlie_rerun' && action.value) {
    c.executionCtx.waitUntil(
      rerunFromSlack(c.env, integration, {
        runId: action.value,
        userId: payload.user?.id ?? '',
        channelId: payload.channel?.id ?? '',
        responseUrl: payload.response_url ?? '',
      }),
    )
  }
  // Acknowledge immediately (empty 200 keeps the original message intact).
  return c.body(null, 200)
})

async function rerunFromSlack(
  env: Env,
  integration: { orgId: string; config: SlackConfig },
  ctx: { runId: string; userId: string; channelId: string; responseUrl: string },
): Promise<void> {
  const { runId, userId, channelId, responseUrl } = ctx
  const email = await usersInfoEmail(integration.config.botToken, userId, env.SLACK_API_BASE)
  const user = email ? await userByEmail(env, integration.orgId, email) : null
  if (!user || !roleHasCapability(user.role, 'runs.trigger')) {
    if (responseUrl) await respondUrl(responseUrl, "You don't have permission to re-run.")
    return
  }

  const orig = await env.DB.prepare(
    `SELECT project_id, environment_id, engine, profile, flow_selection
       FROM runs WHERE id = ? AND org_id = ?`,
  )
    .bind(runId, integration.orgId)
    .first<{
      project_id: string
      environment_id: string
      engine: string
      profile: string
      flow_selection: string
    }>()
  if (!orig) {
    if (responseUrl) await respondUrl(responseUrl, 'Original run not found.')
    return
  }

  const flows = (JSON.parse(orig.flow_selection) as { name: string }[]).map((f) => f.name)
  try {
    const result = await createRun(env, {
      orgId: integration.orgId,
      project: orig.project_id,
      environment: orig.environment_id,
      engine: orig.engine as 'playwright' | 'k6',
      profile: orig.profile,
      flows,
      trigger: 'slack',
      triggeredBy: user.id,
      slackChannel: channelId || null,
      actorId: user.id,
      actorKind: 'user',
    })
    const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/runs/${result.runId}`
    if (responseUrl)
      await respondUrl(responseUrl, `:repeat: Re-running — <${link}|track it>.`, false)
  } catch (err) {
    if (responseUrl) {
      await respondUrl(
        responseUrl,
        `⚠️ ${err instanceof HttpError ? err.message : 'Re-run failed.'}`,
      )
    }
  }
}

export default slack
