import { Hono } from 'hono'
import { z } from 'zod'
import { ROLE_RANK, ROLES, type Role } from '../../shared/roles'
import type { AppBindings } from '../env'
import { writeAudited } from '../lib/audit'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { parseBody } from '../lib/validate'
import { authenticate, authorize } from '../middleware/auth'

const members = new Hono<AppBindings>()

// All member management requires admin+.
members.use('*', authenticate, authorize({ capability: 'members.manage' }))

interface MemberRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  role: Role
  last_login_at: string | null
  created_at: string
  deleted_at: string | null
}

function toDto(row: MemberRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    active: row.deleted_at === null,
  }
}

// --- GET /api/members -------------------------------------------------------
members.get('/', async (c) => {
  const { orgId } = c.get('auth')
  const rows = await c.env.DB.prepare(
    `SELECT id, email, name, avatar_url, role, last_login_at, created_at, deleted_at
       FROM users WHERE org_id = ? ORDER BY created_at ASC`,
  )
    .bind(orgId)
    .all<MemberRow>()
  return c.json({ members: rows.results.map(toDto) })
})

const patchSchema = z.object({ role: z.enum(ROLES) })

// --- PATCH /api/members/:id — change role -----------------------------------
members.patch('/:id', async (c) => {
  const actor = c.get('auth')
  const targetId = c.req.param('id')
  const { role: newRole } = await parseBody(c, patchSchema)

  const target = await loadMember(c.env.DB, actor.orgId, targetId)
  const actorRole = actor.user?.role ?? 'viewer'

  // Only an owner may grant ownership or modify an existing owner.
  if (newRole === 'owner' && actorRole !== 'owner') {
    throw new HttpError('forbidden', 'Only an owner can transfer ownership')
  }
  if (target.role === 'owner' && actorRole !== 'owner') {
    throw new HttpError('forbidden', 'Only an owner can modify an owner')
  }
  // Admins cannot act on peers/superiors (rank guard); owners can do anything.
  if (actorRole !== 'owner' && ROLE_RANK[target.role] >= ROLE_RANK[actorRole]) {
    throw new HttpError('forbidden', 'Cannot modify a member at or above your role')
  }
  // Never strand the org without an owner.
  if (
    target.role === 'owner' &&
    newRole !== 'owner' &&
    (await ownerCount(c.env.DB, actor.orgId)) <= 1
  ) {
    throw new HttpError('conflict', 'Cannot demote the last owner')
  }

  if (target.role === newRole) return c.json({ member: toDto(target) })

  const now = new Date().toISOString()
  await writeAudited(
    c.env.DB,
    [
      c.env.DB.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).bind(
        newRole,
        now,
        targetId,
      ),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'member.role_change',
      entityType: 'user',
      entityId: targetId,
      before: { role: target.role },
      after: { role: newRole },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  return c.json({ member: toDto({ ...target, role: newRole }) })
})

// --- DELETE /api/members/:id — deactivate (soft delete) ---------------------
members.delete('/:id', async (c) => {
  const actor = c.get('auth')
  const targetId = c.req.param('id')

  if (targetId === actor.actorId) {
    throw new HttpError('conflict', 'You cannot deactivate your own account')
  }

  const target = await loadMember(c.env.DB, actor.orgId, targetId)
  const actorRole = actor.user?.role ?? 'viewer'

  if (target.role === 'owner') {
    throw new HttpError('forbidden', 'Owners cannot be deactivated; demote first')
  }
  if (actorRole !== 'owner' && ROLE_RANK[target.role] >= ROLE_RANK[actorRole]) {
    throw new HttpError('forbidden', 'Cannot deactivate a member at or above your role')
  }
  if (target.deleted_at !== null) {
    return c.json({ ok: true }) // already inactive
  }

  const now = new Date().toISOString()
  await writeAudited(
    c.env.DB,
    [
      // Deactivate and invalidate their sessions in the same transaction.
      c.env.DB.prepare(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`).bind(
        now,
        now,
        targetId,
      ),
      c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(targetId),
    ],
    {
      orgId: actor.orgId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      action: 'member.deactivate',
      entityType: 'user',
      entityId: targetId,
      before: { role: target.role, active: true },
      after: { active: false },
      ip: clientIp(c),
      userAgent: userAgent(c),
    },
  )

  return c.json({ ok: true })
})

async function loadMember(db: D1Database, orgId: string, id: string): Promise<MemberRow> {
  const row = await db
    .prepare(
      `SELECT id, email, name, avatar_url, role, last_login_at, created_at, deleted_at
         FROM users WHERE id = ? AND org_id = ?`,
    )
    .bind(id, orgId)
    .first<MemberRow>()
  if (!row) throw new HttpError('not_found', 'Member not found')
  return row
}

async function ownerCount(db: D1Database, orgId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL`,
    )
    .bind(orgId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

export default members
