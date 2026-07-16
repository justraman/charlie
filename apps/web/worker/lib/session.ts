// Session lifecycle. The raw session token lives only in the httpOnly cookie;
// D1 stores SHA-256(token) as the primary key. A D1 leak therefore yields
// hashes that cannot be replayed as cookies. Sliding expiry (default 7 days).

import type { Role } from '../../shared/roles'
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
  db: D1Database,
  input: { userId: string; userAgent?: string | null; ip?: string | null; ttlDays?: number },
): Promise<CreatedSession> {
  const token = randomToken(32)
  const id = await sha256Hex(token)
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS
  const now = new Date().toISOString()
  const expiresAt = isoIn(ttlDays)
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, user_agent, ip, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.userId, input.userAgent ?? null, input.ip ?? null, expiresAt, now)
    .run()
  return { token, expiresAt, maxAgeSec: ttlDays * 86400 }
}

interface SessionRow {
  session_id: string
  expires_at: string
  user_id: string
  email: string
  name: string | null
  avatar_url: string | null
  role: Role
  org_id: string
  deleted_at: string | null
}

/**
 * Resolve a cookie token to its user, or null if missing/expired/deactivated.
 * Applies sliding expiry: if the session is valid and past the halfway point,
 * pushes `expires_at` forward.
 */
export async function resolveSession(
  db: D1Database,
  token: string,
  ttlDays = DEFAULT_TTL_DAYS,
): Promise<SessionUser | null> {
  const id = await sha256Hex(token)
  const row = await db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.name,
              u.avatar_url, u.role, u.org_id, u.deleted_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .bind(id)
    .first<SessionRow>()

  if (!row) return null
  if (row.deleted_at) return null
  if (Date.parse(row.expires_at) <= Date.now()) return null

  // Sliding expiry: refresh once we're past the halfway mark to avoid a write
  // on every request.
  const halfLife = Date.now() + (ttlDays * 86400_000) / 2
  if (Date.parse(row.expires_at) < halfLife) {
    await db
      .prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`)
      .bind(isoIn(ttlDays), id)
      .run()
  }

  return {
    id: row.user_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
    orgId: row.org_id,
  }
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  const id = await sha256Hex(token)
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run()
}
