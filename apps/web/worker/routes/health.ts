import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { createDb } from '../db/client'
import type { AppBindings } from '../env'

const health = new Hono<AppBindings>()

// Liveness + a cheap D1 connectivity probe. Public (no auth).
health.get('/', async (c) => {
  let db: 'ok' | 'error' = 'ok'
  try {
    await createDb(c.env.DB).run(sql`select 1`)
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
