// A message on the runs queue: dispatch this run to the compute plane.
export interface RunQueueMessage {
  runId: string
  orgId: string
}

// Bindings and vars available to the Worker at runtime. Mirrors wrangler.toml
// plus the secrets documented in .dev.vars.example.
export interface Env {
  // Bindings
  ASSETS: Fetcher
  DB: D1Database
  KV: KVNamespace
  ARTIFACTS: R2Bucket
  RUNS_QUEUE: Queue<RunQueueMessage>
  RUN_COORDINATOR: DurableObjectNamespace

  // Vars (wrangler.toml [vars])
  APP_BASE_URL: string
  COOKIE_SECURE?: string
  // First-run bootstrap: used to create the single organization row on the
  // first successful login when none exists yet.
  ORG_NAME?: string
  ALLOWED_EMAIL_DOMAINS?: string // comma-separated, e.g. "example.com,corp.example.com"
  // Dead-shard timeout (ms) the Run Coordinator uses before closing a stalled
  // run. Optional; defaults to 10 minutes. Lowered in tests.
  DEAD_SHARD_TIMEOUT_MS?: string
  // Slack Web API base URL. Defaults to https://slack.com/api; overridden only
  // in local/dev to point at a mock. Never set in production.
  SLACK_API_BASE?: string

  // Slack integration credentials (secrets). Absent → Slack is "not configured"
  // (slash commands 401, run reports skipped). SLACK_TEAM_ID is optional and, when
  // set, tightens inbound matching to that workspace.
  SLACK_BOT_TOKEN?: string
  SLACK_SIGNING_SECRET?: string
  SLACK_TEAM_ID?: string

  // AI provider (single, secrets). Absent → AI analysis is "not configured".
  // AI_PROVIDER selects the kind; AI_ACCOUNT_ID is only used by workers_ai.
  AI_PROVIDER?: string // 'anthropic' | 'openai' | 'workers_ai'
  AI_MODEL?: string
  AI_API_KEY?: string
  AI_ACCOUNT_ID?: string
  // Local-dev only: when set, registers a "dev" Auth.js Credentials provider
  // that signs in as this email with no external IdP (no Google client needed).
  // Lives only in .dev.vars — never `wrangler secret put` it. The provider is
  // registered only when COOKIE_SECURE !== "true" (i.e. not a real deployment).
  DEV_LOGIN_EMAIL?: string
  // Local-dev only: role applied to the DEV_LOGIN_EMAIL user on every dev login.
  // Defaults to "owner" (full access); set to viewer|editor|admin to test RBAC.
  DEV_LOGIN_ROLE?: string

  // Auth.js. AUTH_SECRET signs/encrypts the session JWT (required). AUTH_URL is
  // the auth base (APP_BASE_URL + "/api/auth"); with trustHost it's optional but
  // recommended in prod. Magic-link email goes through Resend — absent locally,
  // where the verification link is logged to the console instead of sent.
  AUTH_SECRET?: string
  AUTH_URL?: string
  AUTH_RESEND_KEY?: string
  AUTH_EMAIL_FROM?: string // e.g. "Charlie <no-reply@yourdomain.com>"

  // Secrets (.dev.vars locally / `wrangler secret put` in prod)
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  CHARLIE_KEK?: string
  // Signs run-scoped callback tokens (HS256). Falls back to CHARLIE_KEK if unset.
  CHARLIE_RUN_TOKEN_SECRET?: string

  // GitHub App (Phase 3 dispatch). Absent locally → dispatch is skipped.
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string // PKCS#8 PEM
  GITHUB_INSTALLATION_ID?: string
  GITHUB_WEBHOOK_SECRET?: string
  GITHUB_RUNNER_REPO?: string // "owner/repo" of the Charlie runner repo
  GITHUB_RUNNER_REF?: string // git ref to dispatch (default "main")
  RUNNER_WORKFLOW_FILE?: string // default "charlie-run.yml"
  AI_ANALYZE_WORKFLOW_FILE?: string // default "ai-analyze.yml"

  // R2 S3 credentials for presigned uploads. Absent → Worker-proxied upload.
  R2_ACCOUNT_ID?: string
  R2_ACCESS_KEY_ID?: string
  R2_SECRET_ACCESS_KEY?: string
  R2_BUCKET?: string // S3 bucket name (default "charlie-artifacts")
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
  // Set by the run-token middleware on machine-callback routes.
  runId: string
}

export type AppBindings = { Bindings: Env; Variables: Variables }
