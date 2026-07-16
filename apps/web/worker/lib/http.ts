// Uniform JSON error shape (docs/API.md): { error: { code, message, details? } }.
import type { Context } from 'hono'

export type ErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'internal'

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
}

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
  get status(): number {
    return STATUS[this.code]
  }
}

export function errorResponse(c: Context, err: HttpError): Response {
  return c.json(
    { error: { code: err.code, message: err.message, details: err.details } },
    // biome-ignore lint/suspicious/noExplicitAny: Hono's status type is a narrow literal union; our codes are a controlled subset.
    err.status as any,
  )
}

/** Best-effort client IP from Cloudflare headers. */
export function clientIp(c: Context): string | null {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  )
}

export function userAgent(c: Context): string | null {
  return c.req.header('user-agent') ?? null
}
