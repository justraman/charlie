// The single protected-route middleware chain: authenticate → authorize →
// rate-limit. Every /api route that isn't explicitly public composes these.

import { getAuthUser } from '@hono/auth-js'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { Capability, Role } from '../../shared/roles'
import { roleHasCapability } from '../../shared/roles'
import { createDb } from '../db/client'
import { api_keys, users } from '../db/schema'
import type { AppBindings } from '../env'
import { bearerToken, parseApiKey } from '../lib/apikeys'
import { constantTimeEqual, sha256Hex } from '../lib/crypto'
import { clientIp, HttpError } from '../lib/http'
import { rateLimit } from '../lib/ratelimit'

/**
 * Authenticate the caller from an Auth.js JWT session (humans) or a Bearer API
 * key (machines) and stash the resolved actor on the context. 401 if neither
 * credential is present or valid.
 */
export const authenticate = createMiddleware<AppBindings>(async (c, next) => {
  const db = createDb(c.env.DB)

  // Humans: Auth.js session (JWT). getAuthUser returns null when unauthenticated
  // (unlike verifyAuth, which throws), so the Bearer-key fallback below still runs.
  const authUser = await getAuthUser(c)
  const uid = typeof authUser?.token?.uid === 'string' ? authUser.token.uid : null
  if (uid) {
    // The JWT carries org/role, but we still hit the DB by PK to honor
    // deactivation (deleted_at) — the revocation the stateless JWT can't give us.
    const row = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatar_url: users.avatar_url,
        role: users.role,
        org_id: users.org_id,
        deleted_at: users.deleted_at,
      })
      .from(users)
      .where(eq(users.id, uid))
      .get()
    if (row && !row.deleted_at) {
      c.set('auth', {
        actorKind: 'user',
        actorId: row.id,
        orgId: row.org_id,
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          avatarUrl: row.avatar_url,
          role: row.role as Role,
        },
      })
      return next()
    }
  }

  const token = bearerToken(c.req.header('authorization'))
  if (token) {
    const parsed = parseApiKey(token)
    if (!parsed) throw new HttpError('unauthenticated', 'Malformed API key')

    const row = await db
      .select({
        id: api_keys.id,
        org_id: api_keys.org_id,
        secret_hash: api_keys.secret_hash,
        scopes: api_keys.scopes,
        project_scope: api_keys.project_scope,
        expires_at: api_keys.expires_at,
        revoked_at: api_keys.revoked_at,
      })
      .from(api_keys)
      .where(eq(api_keys.id, parsed.keyId))
      .get()

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
      Promise.resolve(
        db
          .update(api_keys)
          .set({ last_used_at: new Date().toISOString() })
          .where(eq(api_keys.id, row.id)),
      ),
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
