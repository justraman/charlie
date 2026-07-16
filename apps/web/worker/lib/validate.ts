import type { Context } from 'hono'
import type { z } from 'zod'
import { HttpError } from './http'

/** Parse and validate a JSON request body, returning a 400 with Zod details on failure. */
export async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw new HttpError('bad_request', 'Request body must be valid JSON')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new HttpError('bad_request', 'Validation failed', result.error.issues)
  }
  return result.data
}
