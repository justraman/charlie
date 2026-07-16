// AI flow-generation: the analyze trigger (human) and the two machine callbacks
// the ai-analyze GitHub job uses (analysis-token auth). Mounted at the API root
// so callback routes aren't shadowed by a blanket session middleware — auth is
// attached per route. Draft validation uses flow-core's structured-output
// contract; malformed model output is rejected, never stored blind.

import { flowDraftArraySchema } from '@charlie/flow-core'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { bearerToken } from '../lib/apikeys'
import { writeAudited } from '../lib/audit'
import { decryptString } from '../lib/crypto'
import { dispatchWorkflow, githubConfigured, resolveRunId } from '../lib/github'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import { runTokenSecret, signAnalysisToken, verifyAnalysisToken } from '../lib/run-token'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const ai = new Hono<AppBindings>()

// --- analysis-token middleware (machine callbacks) --------------------------
function analysisTokenAuth() {
  return createMiddleware<AppBindings>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (!token) throw new HttpError('unauthenticated', 'Analysis token required')
    let analysisId: string
    try {
      analysisId = await verifyAnalysisToken(token, runTokenSecret(c.env))
    } catch {
      throw new HttpError('unauthenticated', 'Invalid analysis token')
    }
    if (analysisId !== c.req.param('id')) {
      throw new HttpError('forbidden', 'Token does not authorize this analysis')
    }
    c.set('runId', analysisId) // reuse the runId var slot for the analysis id
    return next()
  })
}

// --- POST /api/projects/:id/analyze (editor) — trigger an analysis ----------
const analyzeSchema = z.object({
  ref: z.string().max(200).optional(),
  providerId: z.string().optional(),
})

ai.post(
  '/projects/:id/analyze',
  authenticate,
  authorize({ capability: 'flows.write' }),
  async (c) => {
    const actor = c.get('auth')
    const projectId = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as z.infer<typeof analyzeSchema>

    const project = await c.env.DB.prepare(
      `SELECT source_repo FROM projects WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    )
      .bind(projectId, actor.orgId)
      .first<{ source_repo: string | null }>()
    if (!project) throw new HttpError('not_found', 'Project not found')
    if (!project.source_repo) {
      throw new HttpError('bad_request', 'Project has no source_repo to analyze')
    }

    // Provider: explicit, else the org default.
    let providerId = body.providerId
    if (!providerId) {
      const org = await c.env.DB.prepare(
        `SELECT default_ai_provider_id FROM organization WHERE id = ?`,
      )
        .bind(actor.orgId)
        .first<{ default_ai_provider_id: string | null }>()
      providerId = org?.default_ai_provider_id ?? undefined
    }
    if (!providerId) throw new HttpError('bad_request', 'No AI provider configured')
    const provider = await c.env.DB.prepare(
      `SELECT id FROM ai_providers WHERE id = ? AND org_id = ?`,
    )
      .bind(providerId, actor.orgId)
      .first<{ id: string }>()
    if (!provider) throw new HttpError('bad_request', 'Unknown AI provider')

    const analysisId = uuidv7()
    const now = new Date().toISOString()

    await writeAudited(
      c.env.DB,
      [
        c.env.DB.prepare(
          `INSERT INTO ai_analyses (id, org_id, project_id, provider_id, ref, status, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).bind(
          analysisId,
          actor.orgId,
          projectId,
          providerId,
          body.ref ?? null,
          actor.actorId,
          now,
        ),
      ],
      {
        orgId: actor.orgId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        action: 'ai.analyze',
        entityType: 'ai_analysis',
        entityId: analysisId,
        after: { projectId, providerId, ref: body.ref ?? null },
        ip: clientIp(c),
        userAgent: userAgent(c),
      },
    )

    let dispatch: 'queued' | 'skipped-no-github' = 'skipped-no-github'
    if (githubConfigured(c.env)) {
      try {
        const token = await signAnalysisToken(analysisId, runTokenSecret(c.env))
        const { dispatchedAt } = await dispatchWorkflow(
          c.env,
          {
            analysisId,
            apiUrl: c.env.APP_BASE_URL,
            analysisToken: token,
            repo: project.source_repo,
            ref: body.ref ?? '',
          },
          {},
          c.env.AI_ANALYZE_WORKFLOW_FILE ?? 'ai-analyze.yml',
        )
        dispatch = 'queued'
        let ghaRunId: string | null = null
        for (let attempt = 0; attempt < 5 && !ghaRunId; attempt++) {
          ghaRunId = await resolveRunId(c.env, { runId: analysisId, sinceIso: dispatchedAt })
          if (!ghaRunId) await new Promise((r) => setTimeout(r, 1500))
        }
        if (ghaRunId) {
          await c.env.DB.prepare(`UPDATE ai_analyses SET gha_run_id = ? WHERE id = ?`)
            .bind(ghaRunId, analysisId)
            .run()
        }
      } catch (err) {
        await c.env.DB.prepare(
          `UPDATE ai_analyses SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        )
          .bind(`dispatch failed: ${(err as Error).message}`, new Date().toISOString(), analysisId)
          .run()
        throw new HttpError('internal', 'Failed to dispatch analysis')
      }
    }

    return c.json({ analysisId, status: 'queued', dispatch }, 202)
  },
)

// --- GET /api/analyses/:id/config (analysis token) — job pulls its config ---
ai.get('/analyses/:id/config', analysisTokenAuth(), async (c) => {
  const analysisId = c.get('runId')
  const row = await c.env.DB.prepare(
    `SELECT a.ref, p.source_repo, pr.name AS provider_name, pr.model, pr.api_key_ciphertext
       FROM ai_analyses a
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN ai_providers pr ON pr.id = a.provider_id
      WHERE a.id = ?`,
  )
    .bind(analysisId)
    .first<{
      ref: string | null
      source_repo: string | null
      provider_name: string | null
      model: string | null
      api_key_ciphertext: string | null
    }>()
  if (!row) throw new HttpError('not_found', 'Analysis not found')

  // Credentials cross into the compute plane here (like a run bundle's secrets).
  let apiKey: string | null = null
  let accountId: string | null = null
  if (row.api_key_ciphertext) {
    try {
      const creds = JSON.parse(await decryptString(row.api_key_ciphertext, c.env.CHARLIE_KEK ?? ''))
      apiKey = creds.apiKey ?? null
      accountId = creds.accountId ?? null
    } catch {
      /* leave null */
    }
  }

  // Mark running on first pickup.
  await c.env.DB.prepare(
    `UPDATE ai_analyses SET status = 'running' WHERE id = ? AND status = 'queued'`,
  )
    .bind(analysisId)
    .run()

  return c.json({
    analysisId,
    repo: row.source_repo,
    ref: row.ref,
    provider: { name: row.provider_name, model: row.model, apiKey, accountId },
  })
})

// --- POST /api/analyses/:id/drafts (analysis token) — ingest drafts ---------
ai.post('/analyses/:id/drafts', analysisTokenAuth(), async (c) => {
  const analysisId = c.get('runId')
  const analysis = await c.env.DB.prepare(`SELECT org_id, project_id FROM ai_analyses WHERE id = ?`)
    .bind(analysisId)
    .first<{ org_id: string; project_id: string }>()
  if (!analysis) throw new HttpError('not_found', 'Analysis not found')

  const raw = await c.req.json().catch(() => null)
  const parsed = flowDraftArraySchema.safeParse((raw as { drafts?: unknown })?.drafts ?? raw)
  if (!parsed.success) {
    throw new HttpError('bad_request', 'Drafts failed schema validation', parsed.error.issues)
  }
  const drafts = parsed.data
  const now = new Date().toISOString()

  const statements = drafts.map((d) =>
    c.env.DB.prepare(
      `INSERT INTO flow_drafts
         (id, org_id, project_id, analysis_id, name, description, engines, steps, load_profile,
          reasoning, source_refs, status, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'ai', ?, ?)`,
    ).bind(
      uuidv7(),
      analysis.org_id,
      analysis.project_id,
      analysisId,
      d.name,
      d.description ?? null,
      JSON.stringify(d.engines),
      JSON.stringify(d.steps),
      d.loadProfile ? JSON.stringify(d.loadProfile) : null,
      d.reasoning ?? null,
      d.sourceRefs ? JSON.stringify(d.sourceRefs) : null,
      now,
      now,
    ),
  )
  statements.push(
    c.env.DB.prepare(
      `UPDATE ai_analyses SET status = 'succeeded', draft_count = ?, finished_at = ? WHERE id = ?`,
    ).bind(drafts.length, now, analysisId),
  )
  await c.env.DB.batch(statements)

  return c.json({ ok: true, stored: drafts.length })
})

export default ai
