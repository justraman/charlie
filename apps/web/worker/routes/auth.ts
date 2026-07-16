import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createDb, type Db } from '../db/client'
import { users } from '../db/schema'
import type { AppBindings } from '../env'
import { writeAudit } from '../lib/audit'
import { randomToken } from '../lib/crypto'
import { clientIp, HttpError, userAgent } from '../lib/http'
import { uuidv7 } from '../lib/ids'
import {
  buildGoogleAuthUrl,
  emailDomain,
  exchangeCodeForTokens,
  type GoogleIdentity,
  generatePkce,
  verifyGoogleIdToken,
} from '../lib/oidc'
import { ensureOrganization, type Organization } from '../lib/org'
import { createSession, destroySession, SESSION_COOKIE } from '../lib/session'
import { authenticate } from '../middleware/auth'

const auth = new Hono<AppBindings>()

const OAUTH_STATE_TTL = 600 // seconds
const OAUTH_KV_PREFIX = 'oauth:'

interface OAuthState {
  verifier: string
  nonce: string
  redirectTo: string
}

/** Only allow same-site relative redirect targets (no protocol-relative //). */
function safeRedirect(raw: string | undefined): string {
  if (!raw?.startsWith('/') || raw.startsWith('//')) return '/'
  return raw
}

function redirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/auth/google/callback`
}

function sessionCookieOptions(env: AppBindings['Bindings'], maxAgeSec: number) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE === 'true',
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: maxAgeSec,
  }
}

// --- GET /api/auth/google/start ---------------------------------------------
auth.get('/google/start', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID
  if (!clientId) throw new HttpError('internal', 'Google SSO is not configured')

  const { verifier, challenge } = await generatePkce()
  const state = randomToken(24)
  const nonce = randomToken(24)
  const redirectTo = safeRedirect(c.req.query('redirect'))

  const stateValue: OAuthState = { verifier, nonce, redirectTo }
  await c.env.KV.put(`${OAUTH_KV_PREFIX}${state}`, JSON.stringify(stateValue), {
    expirationTtl: OAUTH_STATE_TTL,
  })

  const url = buildGoogleAuthUrl({
    clientId,
    redirectUri: redirectUri(c.env.APP_BASE_URL),
    state,
    codeChallenge: challenge,
    nonce,
  })
  return c.redirect(url, 302)
})

// --- GET /api/auth/google/callback ------------------------------------------
auth.get('/google/callback', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new HttpError('internal', 'Google SSO is not configured')

  const code = c.req.query('code')
  const state = c.req.query('state')
  const oauthError = c.req.query('error')
  if (oauthError) return c.redirect(`/login?error=${encodeURIComponent(oauthError)}`, 302)
  if (!code || !state) throw new HttpError('bad_request', 'Missing code or state')

  // Consume the one-time state (defends against CSRF and replay).
  const stateKey = `${OAUTH_KV_PREFIX}${state}`
  const stored = await c.env.KV.get(stateKey)
  if (!stored) throw new HttpError('bad_request', 'Invalid or expired login state')
  await c.env.KV.delete(stateKey)
  const { verifier, nonce, redirectTo } = JSON.parse(stored) as OAuthState

  const tokens = await exchangeCodeForTokens({
    clientId,
    clientSecret,
    code,
    redirectUri: redirectUri(c.env.APP_BASE_URL),
    codeVerifier: verifier,
  })

  const identity = await verifyGoogleIdToken(tokens.id_token, {
    clientId,
    expectedNonce: nonce,
  })

  if (!identity.emailVerified) {
    return c.redirect('/login?error=email_unverified', 302)
  }

  const db = createDb(c.env.DB)
  const org = await ensureOrganization(db, {
    name: c.env.ORG_NAME ?? 'Charlie',
    domainsCsv: c.env.ALLOWED_EMAIL_DOMAINS ?? '',
  })

  // Domain gate — the primary tenancy boundary in single-org mode.
  const domain = emailDomain(identity.email)
  if (!org.allowedEmailDomains.includes(domain)) {
    await writeAudit(db, {
      orgId: org.id,
      actorId: null,
      actorKind: 'system',
      action: 'auth.login_denied',
      entityType: 'auth',
      entityId: null,
      after: { email: identity.email, domain, reason: 'domain_not_allowed' },
      ip: clientIp(c),
      userAgent: userAgent(c),
    })
    return c.redirect('/login?error=domain_not_allowed', 302)
  }

  const user = await upsertUser(db, org, identity)

  const session = await createSession(db, {
    userId: user.id,
    userAgent: userAgent(c),
    ip: clientIp(c),
  })
  setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(c.env, session.maxAgeSec))

  await writeAudit(db, {
    orgId: org.id,
    actorId: user.id,
    actorKind: 'user',
    action: 'auth.login',
    entityType: 'user',
    entityId: user.id,
    after: { email: user.email, role: user.role, firstUser: user.isFirstUser },
    ip: clientIp(c),
    userAgent: userAgent(c),
  })

  return c.redirect(redirectTo, 302)
})

// --- POST /api/auth/logout --------------------------------------------------
auth.post('/logout', authenticate, async (c) => {
  const token = getCookie(c, SESSION_COOKIE)
  const actor = c.get('auth')
  const db = createDb(c.env.DB)
  if (token) await destroySession(db, token)
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
  await writeAudit(db, {
    orgId: actor.orgId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    action: 'auth.logout',
    entityType: 'user',
    entityId: actor.actorId,
  })
  return c.json({ ok: true })
})

// --- GET /api/auth/me -------------------------------------------------------
auth.get('/me', authenticate, (c) => {
  const auth = c.get('auth')
  if (auth.actorKind === 'user' && auth.user) {
    return c.json({
      actorKind: 'user',
      user: {
        id: auth.user.id,
        email: auth.user.email,
        name: auth.user.name,
        avatarUrl: auth.user.avatarUrl,
        role: auth.user.role,
      },
    })
  }
  return c.json({
    actorKind: 'api_key',
    apiKey: { id: auth.apiKey?.id, scopes: auth.apiKey?.scopes ?? [] },
  })
})

// --- helpers ----------------------------------------------------------------

interface UpsertedUser {
  id: string
  email: string
  role: string
  isFirstUser: boolean
}

async function upsertUser(
  db: Db,
  org: Organization,
  identity: GoogleIdentity,
): Promise<UpsertedUser> {
  const now = new Date().toISOString()
  const existing = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.google_sub, identity.sub))
    .get()

  if (existing) {
    await db
      .update(users)
      .set({
        email: identity.email,
        name: identity.name,
        avatar_url: identity.picture,
        last_login_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .where(eq(users.id, existing.id))
    return { id: existing.id, email: identity.email, role: existing.role, isFirstUser: false }
  }

  // First-ever user in the org becomes owner; everyone else starts as viewer.
  const countRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(eq(users.org_id, org.id))
    .get()
  const isFirstUser = (countRow?.n ?? 0) === 0
  const role = isFirstUser ? 'owner' : 'viewer'

  const id = uuidv7()
  await db.insert(users).values({
    id,
    org_id: org.id,
    email: identity.email,
    name: identity.name,
    avatar_url: identity.picture,
    role,
    google_sub: identity.sub,
    last_login_at: now,
    created_at: now,
    updated_at: now,
  })
  return { id, email: identity.email, role, isFirstUser }
}

export default auth
