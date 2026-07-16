import { Hono } from 'hono'
import type { AppBindings } from '../env'

const health = new Hono<AppBindings>()

// Liveness + a cheap D1 connectivity probe. Public (no auth).
health.get('/', async (c) => {
  let db: 'ok' | 'error' = 'ok'
  try {
    await c.env.DB.prepare('SELECT 1').first()
  } catch {
    db = 'error'
  }
  return c.json({
    status: db === 'ok' ? 'ok' : 'degraded',
    service: 'charlie',
    db,
    time: new Date().toISOString(),
  })
})

export default health
