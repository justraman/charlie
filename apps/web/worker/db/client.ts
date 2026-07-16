// The Drizzle handle over the D1 binding. `createDb(env.DB)` wraps the raw
// D1Database; the returned `Db` is what routes, libs, the Durable Object, the
// scheduler and the queue consumer use instead of `.prepare(...)`.
//
// The wrapper is a thin, allocation-cheap object, so creating one per request
// (or per DO/queue invocation) is fine — there is no connection to pool.

import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1'
import { schema } from './schema'

export type Db = DrizzleD1Database<typeof schema>

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema })
}
