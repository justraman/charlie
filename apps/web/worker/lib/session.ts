// Session lifecycle. The raw session token lives only in the httpOnly cookie;
// D1 stores SHA-256(token) as the primary key. A D1 leak therefore yields
// hashes that cannot be replayed as cookies. Sliding expiry (default 7 days).

import { eq } from 'drizzle-orm'
import type { Role } from '../../shared/roles'
import type { Db } from '../db/client'
import { sessions, users } from '../db/schema'
import { randomToken, sha256Hex } from './crypto'

export const SESSION_COOKIE = 'charlie_session'
export const DEFAULT_TTL_DAYS = 7

function isoIn(days: number, from = Date.now()): string {
  return new Date(from + days * 86400_000).toISOString()
}

export interface SessionUser {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  role: Role
  orgId: string
}

export interface CreatedSession {
  token: string
  expiresAt: string
  maxAgeSec: number
}

export async function createSession(
  db: Db,
  input: { userId: string; userAgent?: string | null; ip?: string | null; ttlDays?: number },
): Promise<CreatedSession> {
  const token = randomToken(32)
  const id = await sha256Hex(token)
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS
  const now = new Date().toISOString()
  const expiresAt = isoIn(ttlDays)
  await db.insert(sessions).values({
    id,
    user_id: input.userId,
    user_agent: input.userAgent ?? null,
    ip: input.ip ?? null,
    expires_at: expiresAt,
    created_at: now,
  })
  return { token, expiresAt, maxAgeSec: ttlDays * 86400 }
}

/**
 * Resolve a cookie token to its user, or null if missing/expired/deactivated.
 * Applies sliding expiry: if the session is valid and past the halfway point,
 * pushes `expires_at` forward.
 */
export async function resolveSession(
  db: Db,
  token: string,
  ttlDays = DEFAULT_TTL_DAYS,
): Promise<SessionUser | null> {
  const id = await sha256Hex(token)
  const row = await db
    .select({
      expires_at: sessions.expires_at,
      user_id: users.id,
      email: users.email,
      name: users.name,
      avatar_url: users.avatar_url,
      role: users.role,
      org_id: users.org_id,
      deleted_at: users.deleted_at,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.user_id))
    .where(eq(sessions.id, id))
    .get()

  if (!row) return null
  if (row.deleted_at) return null
  if (Date.parse(row.expires_at) <= Date.now()) return null

  // Sliding expiry: refresh once we're past the halfway mark to avoid a write
  // on every request.
  const halfLife = Date.now() + (ttlDays * 86400_000) / 2
  if (Date.parse(row.expires_at) < halfLife) {
    await db
      .update(sessions)
      .set({ expires_at: isoIn(ttlDays) })
      .where(eq(sessions.id, id))
  }

  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role as Role,
    orgId: row.org_id,
  }
}

export async function destroySession(db: Db, token: string): Promise<void> {
  const id = await sha256Hex(token)
  await db.delete(sessions).where(eq(sessions.id, id))
}
