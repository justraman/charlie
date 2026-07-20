import { authHandler, initAuthConfig } from '@hono/auth-js'
import { Hono } from 'hono'
import { dispatchRun } from './consumer'
import type { AppBindings, Env, RunQueueMessage } from './env'
import { buildAuthConfig } from './lib/authjs'
import { errorResponse, HttpError } from './lib/http'
import { uuidv7 } from './lib/ids'
import aiRoutes from './routes/ai'
import aiProviderRoutes from './routes/ai-providers'
import apiKeyRoutes from './routes/apikeys'
import callbackRoutes from './routes/callbacks'
import environmentRoutes from './routes/environments'
import flowDraftRoutes from './routes/flow-drafts'
import flowRoutes from './routes/flows'
import healthRoutes from './routes/health'
import integrationRoutes from './routes/integrations'
import memberRoutes from './routes/members'
import projectRoutes from './routes/projects'
import runRoutes from './routes/runs'
import scheduleRoutes from './routes/schedules'
import slackRoutes from './routes/slack'
import webhookRoutes from './routes/webhooks'
import { sweepSchedules } from './scheduler'

const app = new Hono<AppBindings>()

// Correlate logs across a request.
app.use('*', async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? uuidv7())
  await next()
})

// Consistent JSON error envelope for every thrown error.
app.onError((err, c) => {
  if (err instanceof HttpError) return errorResponse(c, err)
  console.error(`[${c.get('requestId')}] unhandled error:`, err)
  return errorResponse(c, new HttpError('internal', 'Internal server error'))
})

// --- API surface ------------------------------------------------------------
const api = new Hono<AppBindings>()

// Make the Auth.js config available on every /api request (the authenticate
// middleware reads the session via getAuthUser), then let Auth.js own the whole
// /api/auth/* surface: signin, signout, session, csrf, callback/:provider.
api.use('*', initAuthConfig(buildAuthConfig))
api.use('/auth/*', authHandler())

api.route('/health', healthRoutes)
api.route('/members', memberRoutes)
api.route('/api-keys', apiKeyRoutes)
api.route('/projects', projectRoutes)
api.route('/runs', runRoutes)
api.route('/schedules', scheduleRoutes)
api.route('/integrations', integrationRoutes)
api.route('/ai-providers', aiProviderRoutes)
// environments, flows, drafts, ai, and machine callbacks register full subpaths,
// so they mount at the API root.
api.route('/', environmentRoutes)
api.route('/', flowRoutes)
api.route('/', flowDraftRoutes)
api.route('/', aiRoutes)
api.route('/', callbackRoutes)

// Unknown /api path → JSON 404 (never the SPA shell).
api.all('*', (c) => errorResponse(c, new HttpError('not_found', 'Not found')))

app.route('/api', api)

// Inbound webhooks (GitHub on-merge triggers). Authenticated by HMAC signature,
// not sessions — mounted outside /api.
app.route('/webhooks', webhookRoutes)

// Slack slash command + interactivity. Authenticated by the Slack request
// signature — mounted outside /api.
app.route('/slack', slackRoutes)

// Non-API routes are served from static assets by the runtime (run_worker_first
// scopes the Worker to /api, /webhooks, /slack). This fallback covers any path
// that still reaches the Worker.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export { RunCoordinator } from './do/run-coordinator'

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx)
  },

  // Dispatch consumer: one queued run → one GitHub workflow dispatch.
  async queue(batch: MessageBatch<RunQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await dispatchRun(env, message.body.runId)
        message.ack()
      } catch (err) {
        console.error(`[queue] dispatch error for run ${message.body.runId}:`, err)
        message.retry()
      }
    }
  },

  // Cron Trigger: fire due cron schedules (once per tick). See scheduler.ts.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweepSchedules(env)
        .then((r) => {
          if (r.fired.length) console.info(`[cron] fired ${r.fired.length} schedule(s)`)
        })
        .catch((err) => console.error('[cron] sweep failed:', err)),
    )
  },
}
