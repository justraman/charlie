// Integration status (read-only). All integration credentials — Slack, GitHub,
// AI — are configured via env/Cloudflare secrets, never the DB. This endpoint
// reports whether each is configured and, via a live connectivity check
// (cached briefly in KV), whether it's actually reachable. No secrets are ever
// returned, and there are no mutating endpoints.

import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { getIntegrationsStatus } from '../lib/integrations'
import { authenticate, authorize } from '../middleware/auth'

const integrations = new Hono<AppBindings>()

integrations.use('*', authenticate)

// --- GET /api/integrations — live connection status (no secrets) ------------
// `?refresh=1` bypasses the KV status cache and re-runs the live checks.
integrations.get('/', authorize({ capability: 'projects.view' }), async (c) => {
  const refresh = c.req.query('refresh') === '1'
  const status = await getIntegrationsStatus(c.env, { refresh })
  return c.json(status)
})

export default integrations
