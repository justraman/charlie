// GitHub webhook receiver for on-merge triggers. GitHub POSTs `push` and
// `pull_request` events for watched source repos; we verify the signature, work
// out the merged branch + commit, match it to `on_merge` schedules (by the
// project's `source_repo` and the schedule's `watch_branch`), and create a run
// per match tagged with the commit and `trigger = merge`.
//
// Mounted at /webhooks (outside /api) — no session auth; the HMAC signature is
// the authentication.

import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { HttpError } from '../lib/http'
import { createRun } from '../lib/run-create'
import { verifyGithubSignature } from '../lib/webhook'

const webhooks = new Hono<AppBindings>()

interface MergeEvent {
  repo: string
  branch: string
  commitSha: string | null
}

const ZERO_SHA = '0000000000000000000000000000000000000000'

// Reduce a raw GitHub payload to the merge we care about, or null if it is not
// a merge onto a branch (branch deletes, non-merged PR closes, etc.).
function parseMergeEvent(event: string, payload: Record<string, unknown>): MergeEvent | null {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name
  if (!repo) return null

  if (event === 'push') {
    if (payload.deleted === true) return null
    const ref = typeof payload.ref === 'string' ? payload.ref : ''
    if (!ref.startsWith('refs/heads/')) return null
    const after = typeof payload.after === 'string' ? payload.after : null
    if (!after || after === ZERO_SHA) return null
    return { repo, branch: ref.slice('refs/heads/'.length), commitSha: after }
  }

  if (event === 'pull_request') {
    const pr = payload.pull_request as
      | { merged?: boolean; base?: { ref?: string }; merge_commit_sha?: string }
      | undefined
    if (payload.action !== 'closed' || !pr?.merged) return null
    const branch = pr.base?.ref
    if (!branch) return null
    return { repo, branch, commitSha: pr.merge_commit_sha ?? null }
  }

  return null
}

interface MatchRow {
  id: string
  org_id: string
  project_id: string
  environment_id: string
  flow_selection: string
  engine: string
  profile: string
}

// --- POST /webhooks/github --------------------------------------------------
webhooks.post('/github', async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET
  if (!secret) throw new HttpError('not_found', 'Webhooks are not configured')

  // Verify over the exact bytes GitHub signed.
  const raw = await c.req.text()
  const signature = c.req.header('x-hub-signature-256')
  if (!(await verifyGithubSignature(secret, raw, signature))) {
    throw new HttpError('unauthenticated', 'Invalid webhook signature')
  }

  const event = c.req.header('x-github-event') ?? ''
  if (event === 'ping') return c.json({ ok: true, pong: true })

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new HttpError('bad_request', 'Body must be valid JSON')
  }

  const merge = parseMergeEvent(event, payload)
  if (!merge) return c.json({ ok: true, matched: 0, ignored: event })

  // on_merge schedules whose project watches this repo+branch.
  const matches = await c.env.DB.prepare(
    `SELECT s.id, s.org_id, s.project_id, s.environment_id, s.flow_selection, s.engine, s.profile
       FROM schedules s
       JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE s.trigger_type = 'on_merge' AND s.enabled = 1
        AND s.watch_branch = ? AND p.source_repo = ?`,
  )
    .bind(merge.branch, merge.repo)
    .all<MatchRow>()

  const created: string[] = []
  for (const m of matches.results) {
    try {
      const result = await createRun(c.env, {
        orgId: m.org_id,
        project: m.project_id,
        environment: m.environment_id,
        engine: m.engine as 'playwright' | 'k6',
        profile: m.profile,
        flows: JSON.parse(m.flow_selection) as string[],
        trigger: 'merge',
        triggeredBy: null,
        commitSha: merge.commitSha,
        scheduleId: m.id,
        actorId: null,
        actorKind: 'system',
      })
      created.push(result.runId)
    } catch (err) {
      // One bad schedule (e.g. no engine-compatible flows) shouldn't fail the
      // webhook and trigger GitHub retries; log and continue.
      console.error(`[webhook] schedule ${m.id} failed to create a run:`, err)
    }
  }

  return c.json({ ok: true, repo: merge.repo, branch: merge.branch, matched: created.length })
})

export default webhooks
