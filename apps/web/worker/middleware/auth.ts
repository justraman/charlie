// The single protected-route middleware chain: authenticate → authorize →
// rate-limit. Every /api route that isn't explicitly public composes these.

import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import type { Capability } from '../../shared/roles'
import { roleHasCapability } from '../../shared/roles'
import type { AppBindings } from '../env'
import { bearerToken, parseApiKey } from '../lib/apikeys'
import { constantTimeEqual, sha256Hex } from '../lib/crypto'
import { clientIp, HttpError } from '../lib/http'
import { rateLimit } from '../lib/ratelimit'
import { resolveSession, SESSION_COOKIE } from '../lib/session'

interface ApiKeyRow {
  id: string
  org_id: string
  secret_hash: string
  scopes: string
  project_scope: string | null
  expires_at: string | null
  revoked_at: string | null
}

/**
 * Authenticate the caller from a session cookie (humans) or a Bearer API key
 * (machines) and stash the resolved actor on the context. 401 if neither
 * credential is present or valid.
 */
export const authenticate = createMiddleware<AppBindings>(async (c, next) => {
  const cookieToken = getCookie(c, SESSION_COOKIE)
  if (cookieToken) {
    const user = await resolveSession(c.env.DB, cookieToken)
    if (user) {
      c.set('auth', {
        actorKind: 'user',
        actorId: user.id,
        orgId: user.orgId,
        user,
      })
      return next()
    }
  }

  const token = bearerToken(c.req.header('authorization'))
  if (token) {
    const parsed = parseApiKey(token)
    if (!parsed) throw new HttpError('unauthenticated', 'Malformed API key')

    const row = await c.env.DB.prepare(
      `SELECT id, org_id, secret_hash, scopes, project_scope, expires_at, revoked_at
         FROM api_keys WHERE id = ?`,
    )
      .bind(parsed.keyId)
      .first<ApiKeyRow>()

    if (!row) throw new HttpError('unauthenticated', 'Unknown API key')
    if (row.revoked_at) throw new HttpError('unauthenticated', 'API key revoked')
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      throw new HttpError('unauthenticated', 'API key expired')
    }

    const presentedHash = await sha256Hex(parsed.secret)
    if (!constantTimeEqual(presentedHash, row.secret_hash)) {
      throw new HttpError('unauthenticated', 'Invalid API key')
    }

    // Record last use without blocking the response.
    c.executionCtx.waitUntil(
      c.env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), row.id)
        .run(),
    )

    c.set('auth', {
      actorKind: 'api_key',
      actorId: row.id,
      orgId: row.org_id,
      apiKey: {
        id: row.id,
        scopes: safeJsonArray(row.scopes),
        projectScope: row.project_scope ? safeJsonArray(row.project_scope) : null,
      },
    })
    return next()
  }

  throw new HttpError('unauthenticated', 'Authentication required')
})

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/**
 * Authorize the authenticated actor. Humans are checked against the role→
 * capability matrix; API keys against their granted scopes. A route may
 * require a capability (humans), a scope (machines), or both when both actor
 * kinds are allowed.
 */
export function authorize(opts: { capability?: Capability; scope?: string }) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const auth = c.get('auth')
    if (auth.actorKind === 'user' && auth.user) {
      if (opts.capability && !roleHasCapability(auth.user.role, opts.capability)) {
        throw new HttpError('forbidden', `Requires capability: ${opts.capability}`)
      }
      return next()
    }
    if (auth.actorKind === 'api_key' && auth.apiKey) {
      if (!opts.scope) {
        throw new HttpError('forbidden', 'This endpoint is not available to API keys')
      }
      if (!auth.apiKey.scopes.includes(opts.scope)) {
        throw new HttpError('forbidden', `API key missing scope: ${opts.scope}`)
      }
      return next()
    }
    throw new HttpError('forbidden', 'Not authorized')
  })
}

/** Coarse per-actor rate limit. Defaults: 600 requests / 60s. */
export function rateLimitMiddleware(limit = 600, windowSec = 60) {
  return createMiddleware<AppBindings>(async (c, next) => {
    const auth = c.get('auth')
    const key = auth ? `${auth.actorKind}:${auth.actorId}` : `ip:${clientIp(c) ?? 'unknown'}`
    const { allowed } = await rateLimit(c.env.KV, key, limit, windowSec)
    if (!allowed) throw new HttpError('rate_limited', 'Rate limit exceeded')
    return next()
  })
}
