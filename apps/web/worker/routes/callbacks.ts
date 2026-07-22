// Machine-callback routes used by the compute plane (GitHub Actions runner).
// Authorized by the run-scoped token only — never a session or org API key.
// This is the one place environment secrets leave the control plane: the
// runner fetches a bundle with decrypted secrets to execute the flow.

import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { createDb, type Db } from '../db/client'
import { environments, flow_versions, runs } from '../db/schema'
import type { AppBindings } from '../env'
import { bearerToken } from '../lib/apikeys'
import { expandFlowSteps } from '../lib/flow-expand'
import { getInstallationToken, githubConfigured } from '../lib/github'
import { HttpError } from '../lib/http'
import { callRunDO } from '../lib/run-do'
import { runTokenSecret, verifyRunToken } from '../lib/run-token'
import type { ShardResultPayload } from '../lib/run-types'
import { decryptSecrets } from '../lib/secrets'
import { parseBody } from '../lib/validate'

const callbacks = new Hono<AppBindings>()

interface RunAuthRow {
  id: string
  org_id: string
  project_id: string
  environment_id: string
  engine: string
  profile: string
  flow_selection: string
  expected_shards: number
  status: string
}

// Verify the run token, that it matches the :id in the path, and (unless
// `allowTerminal`) that the run is not already terminal — tokens "expire" on
// terminal status. `finalize` sets allowTerminal because it is an idempotent
// completion sentinel that may arrive after the run has already closed (e.g. a
// single-shard run auto-finalizes when its one shard reports).
function runTokenAuth(opts: { allowTerminal?: boolean } = {}) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    if (!token) throw new HttpError('unauthenticated', 'Run token required')
    let runId: string
    try {
      runId = await verifyRunToken(token, runTokenSecret(c.env))
    } catch {
      throw new HttpError('unauthenticated', 'Invalid run token')
    }
    if (runId !== c.req.param('id')) {
      throw new HttpError('forbidden', 'Run token does not authorize this run')
    }
    const db = createDb(c.env.DB)
    const run = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()
    if (!run) throw new HttpError('not_found', 'Run not found')
    if (!opts.allowTerminal && ['passed', 'failed', 'cancelled'].includes(run.status)) {
      throw new HttpError('unauthenticated', 'Run token expired (run is terminal)')
    }
    c.set('runId', runId)
    return next()
  })
}

async function loadRunForCallback(db: Db, runId: string): Promise<RunAuthRow> {
  const run = await db
    .select({
      id: runs.id,
      org_id: runs.org_id,
      project_id: runs.project_id,
      environment_id: runs.environment_id,
      engine: runs.engine,
      profile: runs.profile,
      flow_selection: runs.flow_selection,
      expected_shards: runs.expected_shards,
      status: runs.status,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .get()
  if (!run) throw new HttpError('not_found', 'Run not found')
  return run
}

// --- GET /api/runs/:id/bundle — the runner's fetch-flow ---------------------
callbacks.get('/runs/:id/bundle', runTokenAuth(), async (c) => {
  const runId = c.get('runId')
  const db = createDb(c.env.DB)
  const run = await loadRunForCallback(db, runId)
  const selection = JSON.parse(run.flow_selection) as {
    flowId: string
    versionId: string
    name: string
    kind?: 'steps' | 'code'
  }[]

  const flows = []
  let hasCodeFlow = false
  for (const sel of selection) {
    const v = await db
      .select({
        steps: flow_versions.steps,
        load_profile: flow_versions.load_profile,
        code_spec: flow_versions.code_spec,
      })
      .from(flow_versions)
      .where(eq(flow_versions.id, sel.versionId))
      .get()
    if (!v) continue
    const kind = sel.kind === 'code' || v.code_spec ? 'code' : 'steps'
    if (kind === 'code') hasCodeFlow = true
    // Inline any `useFlow` references (e.g. a shared login flow) so the runner
    // receives a flat step list. Seed the cycle guard with this flow's own id.
    const rawSteps = JSON.parse(v.steps)
    const steps =
      kind === 'code'
        ? rawSteps
        : await expandFlowSteps(db, run.project_id, rawSteps, { visited: new Set([sel.flowId]) })
    flows.push({
      flowId: sel.flowId,
      name: sel.name,
      kind,
      steps,
      loadProfile: v.load_profile ? JSON.parse(v.load_profile) : null,
      code: v.code_spec ? JSON.parse(v.code_spec) : null,
    })
  }

  // Code flows are cloned on the compute plane. Mint a short-lived installation
  // token so the runner can `git clone` the (private) test repo. Crosses into
  // the compute plane by design, exactly like environment secrets below.
  let cloneToken: string | null = null
  if (hasCodeFlow && githubConfigured(c.env)) {
    try {
      cloneToken = await getInstallationToken(c.env)
    } catch (err) {
      console.error('[bundle] failed to mint clone token:', err)
    }
  }

  const env = await db
    .select({
      base_url: environments.base_url,
      headers: environments.headers,
      secrets_ciphertext: environments.secrets_ciphertext,
      auth_config: environments.auth_config,
    })
    .from(environments)
    .where(eq(environments.id, run.environment_id))
    .get()
  if (!env) throw new HttpError('not_found', 'Environment not found')

  // Secrets are decrypted here and cross into the compute plane by design.
  const secrets = await decryptSecrets(env.secrets_ciphertext, c.env.CHARLIE_KEK)

  return c.json({
    runId,
    engine: run.engine,
    profile: run.profile,
    expectedShards: run.expected_shards,
    cloneToken,
    environment: {
      baseUrl: env.base_url,
      headers: JSON.parse(env.headers) as Record<string, string>,
      secrets,
      authConfig: env.auth_config ? JSON.parse(env.auth_config) : null,
    },
    flows,
  })
})

const shardResultSchema = z.object({
  shardIndex: z.number().int().nonnegative(),
  status: z.enum(['passed', 'failed', 'errored']),
  runner: z.string().optional(),
  publicIp: z.string().optional(),
  flowResults: z
    .array(
      z.object({
        flow: z.string(),
        status: z.enum(['passed', 'failed']),
        durationMs: z.number().optional(),
        failedStep: z.number().optional(),
        error: z.string().optional(),
      }),
    )
    .optional(),
  metrics: z.unknown().optional(),
  runtimeIssues: z.unknown().optional(),
  events: z.unknown().optional(),
  artifactKeys: z.array(z.string()).optional(),
})

// --- POST /api/runs/:id/shard-result ----------------------------------------
callbacks.post('/runs/:id/shard-result', runTokenAuth(), async (c) => {
  const runId = c.get('runId')
  const payload = (await parseBody(c, shardResultSchema)) as ShardResultPayload
  const res = await callRunDO(c.env, runId, '/shard-result', { body: payload })
  if (!res.ok) throw new HttpError('conflict', await res.text())
  return c.json({ ok: true })
})

const presignSchema = z.object({
  shard: z.number().int().nonnegative(),
  name: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\w.\-/]+$/, 'invalid artifact name'),
})

// --- POST /api/runs/:id/artifacts/presign -----------------------------------
// Returns an upload URL. When R2 S3 credentials are configured this could be a
// direct presigned PUT; by default it is a Worker-proxied upload (keeps R2
// creds server-side and works locally). Key layout: runs/{runId}/{shard}/{name}.
callbacks.post('/runs/:id/artifacts/presign', runTokenAuth(), async (c) => {
  const runId = c.get('runId')
  const { shard, name } = await parseBody(c, presignSchema)
  const key = `runs/${runId}/${shard}/${name}`
  const base = c.env.APP_BASE_URL.replace(/\/$/, '')
  return c.json({
    key,
    method: 'PUT',
    uploadUrl: `${base}/api/runs/${runId}/artifacts/upload?key=${encodeURIComponent(key)}`,
  })
})

// --- PUT /api/runs/:id/artifacts/upload — Worker-proxied R2 write -----------
callbacks.put('/runs/:id/artifacts/upload', runTokenAuth(), async (c) => {
  const runId = c.get('runId')
  const key = c.req.query('key')
  if (!key || !key.startsWith(`runs/${runId}/`)) {
    throw new HttpError('bad_request', 'key must be under this run')
  }
  const contentType = c.req.header('content-type') ?? 'application/octet-stream'
  const body = await c.req.arrayBuffer()
  await c.env.ARTIFACTS.put(key, body, { httpMetadata: { contentType } })
  return c.json({ ok: true, key, size: body.byteLength })
})

// --- POST /api/runs/:id/finalize — completion sentinel ----------------------
callbacks.post('/runs/:id/finalize', runTokenAuth({ allowTerminal: true }), async (c) => {
  const runId = c.get('runId')
  await callRunDO(c.env, runId, '/finalize', { method: 'POST' })
  return c.json({ ok: true })
})

export default callbacks
