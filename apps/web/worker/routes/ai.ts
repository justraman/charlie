// AI flow-generation: the analyze trigger (human) and the two machine callbacks
// the ai-analyze GitHub job uses (analysis-token auth). Mounted at the API root
// so callback routes aren't shadowed by a blanket session middleware — auth is
// attached per route. Draft validation uses flow-core's structured-output
// contract; malformed model output is rejected, never stored blind.

import { flowDraftArraySchema } from '@charlie/flow-core'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { createDb } from '../db/client'
import { ai_analyses, ai_providers, flow_drafts, organization, projects } from '../db/schema'
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
    const db = createDb(c.env.DB)
    const body = (await c.req.json().catch(() => ({}))) as z.infer<typeof analyzeSchema>

    const project = await db
      .select({ source_repo: projects.source_repo })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.org_id, actor.orgId),
          isNull(projects.deleted_at),
        ),
      )
      .get()
    if (!project) throw new HttpError('not_found', 'Project not found')
    if (!project.source_repo) {
      throw new HttpError('bad_request', 'Project has no source_repo to analyze')
    }

    // Provider: explicit, else the org default.
    let providerId = body.providerId
    if (!providerId) {
      const org = await db
        .select({ default_ai_provider_id: organization.default_ai_provider_id })
        .from(organization)
        .where(eq(organization.id, actor.orgId))
        .get()
      providerId = org?.default_ai_provider_id ?? undefined
    }
    if (!providerId) throw new HttpError('bad_request', 'No AI provider configured')
    const provider = await db
      .select({ id: ai_providers.id })
      .from(ai_providers)
      .where(and(eq(ai_providers.id, providerId), eq(ai_providers.org_id, actor.orgId)))
      .get()
    if (!provider) throw new HttpError('bad_request', 'Unknown AI provider')

    const analysisId = uuidv7()
    const now = new Date().toISOString()

    await writeAudited(
      db,
      [
        db.insert(ai_analyses).values({
          id: analysisId,
          org_id: actor.orgId,
          project_id: projectId,
          provider_id: providerId,
          ref: body.ref ?? null,
          status: 'queued',
          created_by: actor.actorId,
          created_at: now,
        }),
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
          await db
            .update(ai_analyses)
            .set({ gha_run_id: ghaRunId })
            .where(eq(ai_analyses.id, analysisId))
        }
      } catch (err) {
        await db
          .update(ai_analyses)
          .set({
            status: 'failed',
            error: `dispatch failed: ${(err as Error).message}`,
            finished_at: new Date().toISOString(),
          })
          .where(eq(ai_analyses.id, analysisId))
        throw new HttpError('internal', 'Failed to dispatch analysis')
      }
    }

    return c.json({ analysisId, status: 'queued', dispatch }, 202)
  },
)

// --- GET /api/analyses/:id/config (analysis token) — job pulls its config ---
ai.get('/analyses/:id/config', analysisTokenAuth(), async (c) => {
  const analysisId = c.get('runId')
  const db = createDb(c.env.DB)
  const row = await db
    .select({
      ref: ai_analyses.ref,
      source_repo: projects.source_repo,
      provider_name: ai_providers.name,
      model: ai_providers.model,
      api_key_ciphertext: ai_providers.api_key_ciphertext,
    })
    .from(ai_analyses)
    .innerJoin(projects, eq(projects.id, ai_analyses.project_id))
    .leftJoin(ai_providers, eq(ai_providers.id, ai_analyses.provider_id))
    .where(eq(ai_analyses.id, analysisId))
    .get()
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
  await db
    .update(ai_analyses)
    .set({ status: 'running' })
    .where(and(eq(ai_analyses.id, analysisId), eq(ai_analyses.status, 'queued')))

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
  const db = createDb(c.env.DB)
  const analysis = await db
    .select({ org_id: ai_analyses.org_id, project_id: ai_analyses.project_id })
    .from(ai_analyses)
    .where(eq(ai_analyses.id, analysisId))
    .get()
  if (!analysis) throw new HttpError('not_found', 'Analysis not found')

  const raw = await c.req.json().catch(() => null)
  const parsed = flowDraftArraySchema.safeParse((raw as { drafts?: unknown })?.drafts ?? raw)
  if (!parsed.success) {
    throw new HttpError('bad_request', 'Drafts failed schema validation', parsed.error.issues)
  }
  const drafts = parsed.data
  const now = new Date().toISOString()

  const inserts = drafts.map((d) =>
    db.insert(flow_drafts).values({
      id: uuidv7(),
      org_id: analysis.org_id,
      project_id: analysis.project_id,
      analysis_id: analysisId,
      name: d.name,
      description: d.description ?? null,
      engines: JSON.stringify(d.engines),
      steps: JSON.stringify(d.steps),
      load_profile: d.loadProfile ? JSON.stringify(d.loadProfile) : null,
      reasoning: d.reasoning ?? null,
      source_refs: d.sourceRefs ? JSON.stringify(d.sourceRefs) : null,
      status: 'draft',
      origin: 'ai',
      created_at: now,
      updated_at: now,
    }),
  )
  await db.batch([
    db
      .update(ai_analyses)
      .set({ status: 'succeeded', draft_count: drafts.length, finished_at: now })
      .where(eq(ai_analyses.id, analysisId)),
    ...inserts,
  ])

  return c.json({ ok: true, stored: drafts.length })
})

export default ai
