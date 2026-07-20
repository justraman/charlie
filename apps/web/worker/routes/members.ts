import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { ROLE_RANK, ROLES, type Role } from '../../shared/roles'
import { createDb, type Db } from '../db/client'
import { users } from '../db/schema'
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

// The column set returned to clients — mirrors MemberRow.
const MEMBER_COLS = {
  id: users.id,
  email: users.email,
  name: users.name,
  avatar_url: users.avatar_url,
  role: users.role,
  last_login_at: users.last_login_at,
  created_at: users.created_at,
  deleted_at: users.deleted_at,
}

// --- GET /api/members -------------------------------------------------------
members.get('/', async (c) => {
  const { orgId } = c.get('auth')
  const db = createDb(c.env.DB)
  const rows = await db
    .select(MEMBER_COLS)
    .from(users)
    .where(eq(users.org_id, orgId))
    .orderBy(asc(users.created_at))
  return c.json({ members: rows.map((row) => toDto(row as MemberRow)) })
})

const patchSchema = z.object({ role: z.enum(ROLES) })

// --- PATCH /api/members/:id — change role -----------------------------------
members.patch('/:id', async (c) => {
  const actor = c.get('auth')
  const targetId = c.req.param('id')
  const { role: newRole } = await parseBody(c, patchSchema)
  const db = createDb(c.env.DB)

  const target = await loadMember(db, actor.orgId, targetId)
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
  if (target.role === 'owner' && newRole !== 'owner' && (await ownerCount(db, actor.orgId)) <= 1) {
    throw new HttpError('conflict', 'Cannot demote the last owner')
  }

  if (target.role === newRole) return c.json({ member: toDto(target) })

  const now = new Date().toISOString()
  await writeAudited(
    db,
    [db.update(users).set({ role: newRole, updated_at: now }).where(eq(users.id, targetId))],
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
  const db = createDb(c.env.DB)

  if (targetId === actor.actorId) {
    throw new HttpError('conflict', 'You cannot deactivate your own account')
  }

  const target = await loadMember(db, actor.orgId, targetId)
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
    db,
    [
      // Mark deleted_at; the authenticate middleware rejects the user on their
      // next request (JWT sessions carry no server-side row to delete).
      db.update(users).set({ deleted_at: now, updated_at: now }).where(eq(users.id, targetId)),
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

async function loadMember(db: Db, orgId: string, id: string): Promise<MemberRow> {
  const row = await db
    .select(MEMBER_COLS)
    .from(users)
    .where(and(eq(users.id, id), eq(users.org_id, orgId)))
    .get()
  if (!row) throw new HttpError('not_found', 'Member not found')
  return row as MemberRow
}

async function ownerCount(db: Db, orgId: string): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.org_id, orgId), eq(users.role, 'owner'), isNull(users.deleted_at)))
    .get()
  return row?.n ?? 0
}

export default members
