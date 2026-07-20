// Auth.js configuration for the Worker. Auth.js owns human sessions (JWT
// strategy); this module wires the providers, the company-email domain gate,
// and the callbacks/events that keep Charlie's user model (org, role) and audit
// trail intact. Adding a provider later is just another entry in `providers`.

import Credentials from '@auth/core/providers/credentials'
import Google from '@auth/core/providers/google'
import Resend from '@auth/core/providers/resend'
import type { AuthConfig } from '@hono/auth-js'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { isRole, type Role } from '../../shared/roles'
import { createDb } from '../db/client'
import { users } from '../db/schema'
import type { AppBindings, Env } from '../env'
import { writeAudit } from './audit'
import { type CharlieAdapterUser, createAuthAdapter } from './authjs-adapter'
import { uuidv7 } from './ids'
import { ensureOrganization } from './org'

/** Extract the domain (portion after the last '@'), lowercased. Exported for
 *  tests; formerly lived in the now-deleted oidc.ts. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at === -1 ? '' : email.slice(at + 1).toLowerCase()
}

/** The company-domain gate decision, pure and unit-testable. An empty/invalid
 *  address, or one whose domain isn't in the allow-list, is rejected. */
export function isEmailAllowed(email: string | null | undefined, allowedDomains: string[]): boolean {
  const address = (email ?? '').toLowerCase()
  const domain = emailDomain(address)
  return address.length > 0 && domain.length > 0 && allowedDomains.includes(domain)
}

/** True only for local/dev deployments (no Secure cookies) — used to gate the
 *  dev Credentials provider and the console magic-link sender. */
function isLocal(env: Env): boolean {
  return env.COOKIE_SECURE !== 'true'
}

function buildProviders(env: Env): AuthConfig['providers'] {
  const providers: AuthConfig['providers'] = []

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Company email is the identity; let a person who first used a magic
        // link also sign in with Google (same verified address → same user).
        allowDangerousEmailAccountLinking: true,
      }),
    )
  }

  // Email magic-link via Resend. Locally (or with no API key) we log the link
  // to the Worker console instead of sending mail, so dev needs no email setup.
  providers.push(
    Resend({
      apiKey: env.AUTH_RESEND_KEY ?? 'dev',
      from: env.AUTH_EMAIL_FROM ?? 'Charlie <onboarding@resend.dev>',
      async sendVerificationRequest({ identifier, url }) {
        if (isLocal(env) || !env.AUTH_RESEND_KEY) {
          console.log(`[auth] magic-link for ${identifier}: ${url}`)
          return
        }
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.AUTH_RESEND_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: env.AUTH_EMAIL_FROM ?? 'Charlie <onboarding@resend.dev>',
            to: identifier,
            subject: 'Sign in to Charlie',
            html: `<p>Sign in to Charlie by clicking <a href="${url}">this link</a>. It expires shortly.</p>`,
            text: `Sign in to Charlie: ${url}`,
          }),
        })
        if (!res.ok) {
          throw new Error(`Resend send failed (${res.status}): ${await res.text().catch(() => '')}`)
        }
      },
    }),
  )

  // Local-dev shortcut: a one-click sign-in as DEV_LOGIN_EMAIL with no external
  // IdP. Registered only when opted in AND not a Secure (production) deployment.
  if (isLocal(env) && env.DEV_LOGIN_EMAIL) {
    providers.push(
      Credentials({
        id: 'dev',
        name: 'Dev login',
        credentials: {},
        async authorize() {
          const email = env.DEV_LOGIN_EMAIL!.toLowerCase()
          const db = createDb(env.DB)
          const org = await ensureOrganization(db, {
            name: env.ORG_NAME ?? 'Charlie',
            domainsCsv: env.ALLOWED_EMAIL_DOMAINS ?? '',
          })
          const role: Role =
            env.DEV_LOGIN_ROLE && isRole(env.DEV_LOGIN_ROLE) ? env.DEV_LOGIN_ROLE : 'owner'
          const name = email.split('@')[0] ?? email
          const now = new Date().toISOString()
          const existing = await db.select().from(users).where(eq(users.email, email)).get()
          let id: string
          if (existing) {
            id = existing.id
            await db
              .update(users)
              .set({ role, last_login_at: now, updated_at: now, deleted_at: null })
              .where(eq(users.id, id))
          } else {
            id = uuidv7()
            await db.insert(users).values({
              id,
              org_id: org.id,
              email,
              name,
              role,
              last_login_at: now,
              created_at: now,
              updated_at: now,
            })
          }
          // Shape mirrors CharlieAdapterUser so the jwt callback finds role/orgId.
          return { id, email, name, role, orgId: org.id } as CharlieAdapterUser
        },
      }),
    )
  }

  return providers
}

export function buildAuthConfig(c: Context<AppBindings>): AuthConfig {
  const env = c.env
  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    basePath: '/api/auth',
    // An adapter is present (needed for magic-link tokens + account linking), so
    // Auth.js would default to database sessions — force JWT explicitly.
    session: { strategy: 'jwt' },
    adapter: createAuthAdapter(env),
    // Reuse the SPA login screen for sign-in, errors (?error=...), and the
    // "check your email" step after requesting a magic link.
    pages: { signIn: '/login', error: '/login', verifyRequest: '/login?verify=email' },
    providers: buildProviders(env),
    callbacks: {
      // The company-email domain gate — the primary tenancy boundary. Runs for
      // Google sign-in and for the magic-link *send* step (verificationRequest),
      // so a non-company address is rejected before any mail goes out.
      async signIn({ user, account, email }) {
        if (account?.provider === 'dev') return true // operator opted in locally
        const address = (user?.email ?? '').toLowerCase()
        const domain = emailDomain(address)
        const db = createDb(env.DB)
        const org = await ensureOrganization(db, {
          name: env.ORG_NAME ?? 'Charlie',
          domainsCsv: env.ALLOWED_EMAIL_DOMAINS ?? '',
        })
        if (!isEmailAllowed(address, org.allowedEmailDomains)) {
          await writeAudit(db, {
            orgId: org.id,
            actorId: null,
            actorKind: 'system',
            action: 'auth.login_denied',
            entityType: 'auth',
            entityId: null,
            after: {
              email: address,
              domain,
              reason: 'domain_not_allowed',
              verificationRequest: email?.verificationRequest ?? false,
            },
          })
          return false // → redirect to /login?error=AccessDenied
        }
        return true
      },

      // Persist Charlie's identity fields into the JWT on sign-in so the
      // authenticate middleware can build its AuthContext with no DB read for
      // org/role (it still does a cheap deleted_at check).
      async jwt({ token, user }) {
        if (user) {
          const u = user as Partial<CharlieAdapterUser>
          if (u.id) token.uid = u.id
          if (u.orgId) token.orgId = u.orgId
          if (u.role) token.role = u.role
        }
        return token
      },

      // Expose id/role/orgId on the session so the SPA (/api/auth/session) can
      // render role-gated UI.
      async session({ session, token }) {
        if (session.user) {
          if (typeof token.uid === 'string') session.user.id = token.uid
          const su = session.user as { role?: Role; orgId?: string }
          if (typeof token.role === 'string') su.role = token.role as Role
          if (typeof token.orgId === 'string') su.orgId = token.orgId
        }
        return session
      },
    },
    events: {
      // Audit successful logins and bump last_login_at. `user.id` is the Charlie
      // user id for every provider (adapter user, or the dev authorize return).
      async signIn({ user }) {
        if (!user?.id) return
        const db = createDb(env.DB)
        const row = await db
          .select({ org_id: users.org_id, email: users.email, role: users.role })
          .from(users)
          .where(eq(users.id, user.id))
          .get()
        if (!row) return
        const now = new Date().toISOString()
        await db
          .update(users)
          .set({ last_login_at: now, updated_at: now })
          .where(eq(users.id, user.id))
        await writeAudit(db, {
          orgId: row.org_id,
          actorId: user.id,
          actorKind: 'user',
          action: 'auth.login',
          entityType: 'user',
          entityId: user.id,
          after: { email: row.email, role: row.role },
        })
      },
      async signOut(message) {
        const token = 'token' in message ? message.token : null
        const uid = typeof token?.uid === 'string' ? token.uid : null
        const orgId = typeof token?.orgId === 'string' ? token.orgId : null
        if (!uid || !orgId) return
        const db = createDb(env.DB)
        await writeAudit(db, {
          orgId,
          actorId: uid,
          actorKind: 'user',
          action: 'auth.logout',
          entityType: 'user',
          entityId: uid,
        })
      },
    },
  }
}
