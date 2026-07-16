import { Hono } from 'hono'
import type { AppBindings } from './env'
import { errorResponse, HttpError } from './lib/http'
import { uuidv7 } from './lib/ids'
import apiKeyRoutes from './routes/apikeys'
import authRoutes from './routes/auth'
import environmentRoutes from './routes/environments'
import flowRoutes from './routes/flows'
import healthRoutes from './routes/health'
import memberRoutes from './routes/members'
import projectRoutes from './routes/projects'

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
// environments and flows register full subpaths (/projects/:id/... and
// /environments/:id, /flows/:id) so they mount at the API root.
api.route('/', environmentRoutes)
api.route('/', flowRoutes)

// Unknown /api path → JSON 404 (never the SPA shell).
api.all('*', (c) => errorResponse(c, new HttpError('not_found', 'Not found')))

app.route('/api', api)

// Non-API routes are served from static assets by the runtime (run_worker_first
// scopes the Worker to /api, /webhooks, /slack). This fallback covers any path
// that still reaches the Worker.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw))

export default app
