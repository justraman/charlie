import { Hono } from 'hono'
import { dispatchRun } from './consumer'
import type { AppBindings, Env, RunQueueMessage } from './env'
import { errorResponse, HttpError } from './lib/http'
import { uuidv7 } from './lib/ids'
import apiKeyRoutes from './routes/apikeys'
import authRoutes from './routes/auth'
import callbackRoutes from './routes/callbacks'
import environmentRoutes from './routes/environments'
import flowRoutes from './routes/flows'
import healthRoutes from './routes/health'
import memberRoutes from './routes/members'
import projectRoutes from './routes/projects'
import runRoutes from './routes/runs'

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
api.route('/health', healthRoutes)
api.route('/auth', authRoutes)
api.route('/members', memberRoutes)
api.route('/api-keys', apiKeyRoutes)
api.route('/projects', projectRoutes)
api.route('/runs', runRoutes)
// environments, flows, and machine callbacks register full subpaths, so they
// mount at the API root.
api.route('/', environmentRoutes)
api.route('/', flowRoutes)
api.route('/', callbackRoutes)

// Unknown /api path → JSON 404 (never the SPA shell).
api.all('*', (c) => errorResponse(c, new HttpError('not_found', 'Not found')))

app.route('/api', api)

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
}
