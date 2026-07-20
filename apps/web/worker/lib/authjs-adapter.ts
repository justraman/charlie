// A minimal Auth.js adapter mapped onto Charlie's existing D1 schema. We roll
// our own (instead of @auth/drizzle-adapter) because Charlie's `users` table
// carries `org_id` and `role` (both NOT NULL) that the stock adapter cannot
// populate — `createUser` here sets the single org and the first-user-owner
// role. Session methods are intentionally absent: humans use the JWT session
// strategy, so Auth.js never touches a sessions table.

import type { Adapter, AdapterAccount, AdapterUser, VerificationToken } from '@auth/core/adapters'
import { and, eq, sql } from 'drizzle-orm'
import type { Role } from '../../shared/roles'
import { createDb, type Db } from '../db/client'
import { accounts, users, verification_token } from '../db/schema'
import type { Env } from '../env'
import { uuidv7 } from './ids'
import { ensureOrganization } from './org'

/** Charlie's user row exposed to Auth.js, with the extra fields our callbacks
 *  read off the `user` argument (role/orgId land in the JWT; deletedAt lets the
 *  middleware reject deactivated users). */
export interface CharlieAdapterUser extends AdapterUser {
  role: Role
  orgId: string
  deletedAt: string | null
}

type UserRow = typeof users.$inferSelect

function toAdapterUser(row: UserRow): CharlieAdapterUser {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified ?? null,
    name: row.name,
    image: row.avatar_url,
    role: row.role as Role,
    orgId: row.org_id,
    deletedAt: row.deleted_at,
  }
}

export function createAuthAdapter(env: Env): Adapter {
  const db: Db = createDb(env.DB)

  async function firstUserRole(orgId: string): Promise<Role> {
    const countRow = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.org_id, orgId))
      .get()
    // First-ever user in the org becomes owner; everyone else starts as viewer.
    return (countRow?.n ?? 0) === 0 ? 'owner' : 'viewer'
  }

  return {
    async createUser(user: AdapterUser): Promise<CharlieAdapterUser> {
      const org = await ensureOrganization(db, {
        name: env.ORG_NAME ?? 'Charlie',
        domainsCsv: env.ALLOWED_EMAIL_DOMAINS ?? '',
      })
      const role = await firstUserRole(org.id)
      const now = new Date().toISOString()
      const id = uuidv7() // Charlie ids are uuidv7, not Auth.js's random id.
      await db.insert(users).values({
        id,
        org_id: org.id,
        email: user.email.toLowerCase(),
        email_verified: user.emailVerified ?? null,
        name: user.name ?? null,
        avatar_url: user.image ?? null,
        role,
        last_login_at: now,
        created_at: now,
        updated_at: now,
      })
      return {
        id,
        email: user.email.toLowerCase(),
        emailVerified: user.emailVerified ?? null,
        name: user.name ?? null,
        image: user.image ?? null,
        role,
        orgId: org.id,
        deletedAt: null,
      }
    },

    async getUser(id: string): Promise<CharlieAdapterUser | null> {
      const row = await db.select().from(users).where(eq(users.id, id)).get()
      return row ? toAdapterUser(row) : null
    },

    async getUserByEmail(email: string): Promise<CharlieAdapterUser | null> {
      const row = await db.select().from(users).where(eq(users.email, email.toLowerCase())).get()
      return row ? toAdapterUser(row) : null
    },

    async getUserByAccount({ provider, providerAccountId }): Promise<CharlieAdapterUser | null> {
      const row = await db
        .select({ user: users })
        .from(accounts)
        .innerJoin(users, eq(users.id, accounts.user_id))
        .where(
          and(eq(accounts.provider, provider), eq(accounts.provider_account_id, providerAccountId)),
        )
        .get()
      return row ? toAdapterUser(row.user) : null
    },

    async updateUser(
      user: Partial<AdapterUser> & Pick<AdapterUser, 'id'>,
    ): Promise<CharlieAdapterUser> {
      const patch: Partial<UserRow> = { updated_at: new Date().toISOString() }
      if (user.email !== undefined) patch.email = user.email.toLowerCase()
      if (user.emailVerified !== undefined) patch.email_verified = user.emailVerified
      if (user.name !== undefined) patch.name = user.name
      if (user.image !== undefined) patch.avatar_url = user.image
      await db.update(users).set(patch).where(eq(users.id, user.id))
      const row = await db.select().from(users).where(eq(users.id, user.id)).get()
      if (!row) throw new Error(`updateUser: user ${user.id} not found`)
      return toAdapterUser(row)
    },

    async linkAccount(account: AdapterAccount): Promise<void> {
      await db.insert(accounts).values({
        id: uuidv7(),
        user_id: account.userId,
        type: account.type,
        provider: account.provider,
        provider_account_id: account.providerAccountId,
        refresh_token: account.refresh_token ?? null,
        access_token: account.access_token ?? null,
        expires_at: typeof account.expires_at === 'number' ? account.expires_at : null,
        token_type: account.token_type ?? null,
        scope: account.scope ?? null,
        id_token: account.id_token ?? null,
        session_state: typeof account.session_state === 'string' ? account.session_state : null,
      })
    },

    async createVerificationToken(token: VerificationToken): Promise<VerificationToken> {
      await db.insert(verification_token).values({
        identifier: token.identifier,
        token: token.token,
        expires: token.expires,
      })
      return token
    },

    async useVerificationToken(params: {
      identifier: string
      token: string
    }): Promise<VerificationToken | null> {
      const row = await db
        .select()
        .from(verification_token)
        .where(
          and(
            eq(verification_token.identifier, params.identifier),
            eq(verification_token.token, params.token),
          ),
        )
        .get()
      if (!row) return null
      // Single-use: consume it.
      await db
        .delete(verification_token)
        .where(
          and(
            eq(verification_token.identifier, params.identifier),
            eq(verification_token.token, params.token),
          ),
        )
      return { identifier: row.identifier, token: row.token, expires: row.expires }
    },
  }
}
