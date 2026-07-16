// Bindings and vars available to the Worker at runtime. Mirrors wrangler.toml
// plus the secrets documented in .dev.vars.example.
export interface Env {
  // Bindings
  ASSETS: Fetcher
  DB: D1Database
  KV: KVNamespace

  // Vars (wrangler.toml [vars])
  APP_BASE_URL: string
  COOKIE_SECURE?: string
  // First-run bootstrap: used to create the single organization row on the
  // first successful login when none exists yet.
  ORG_NAME?: string
  ALLOWED_EMAIL_DOMAINS?: string // comma-separated, e.g. "example.com,corp.example.com"

  // Secrets (.dev.vars locally / `wrangler secret put` in prod)
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  CHARLIE_KEK?: string
}

// Per-request context resolved by the auth middleware and read by routes.
export interface AuthContext {
  actorKind: 'user' | 'api_key' | 'system'
  actorId: string
  orgId: string
  // Populated for human sessions.
  user?: {
    id: string
    email: string
    name: string | null
    avatarUrl: string | null
    role: import('../shared/roles').Role
  }
  // Populated for API-key callers.
  apiKey?: {
    id: string
    scopes: string[]
    projectScope: string[] | null
  }
}

// Hono variable map — what `c.get(...)` / `c.set(...)` carry.
export interface Variables {
  auth: AuthContext
  requestId: string
}

export type AppBindings = { Bindings: Env; Variables: Variables }
