// Drizzle schema — the single source of truth for Charlie's D1 system-of-record.
// `drizzle-kit generate` diffs this file to produce the forward-only SQL
// migrations in /migrations, which `wrangler d1 migrations apply` then applies.
//
// Conventions mirrored from the original hand-written SQL:
//  - Primary keys are UUIDv7 TEXT; timestamps are ISO-8601 UTC TEXT.
//  - JSON payloads are stored as TEXT and (de)serialized in application code
//    (kept as `text()` rather than `{ mode: 'json' }` so behavior is unchanged).
//  - Column *property* names are snake_case, matching the DB column names, so
//    query results line up with the existing row DTO mappers.
//  - `org_id` rides on org-owned rows so a future multi-org split stays a data
//    migration rather than a schema rewrite.

import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

// --- 0001_init ---------------------------------------------------------------

export const organization = sqliteTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  allowed_email_domains: text('allowed_email_domains').notNull().default('[]'), // JSON array
  default_ai_provider_id: text('default_ai_provider_id'), // reserved here; set via provider API
  settings: text('settings').notNull().default('{}'), // JSON
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
})

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    email: text('email').notNull(),
    // Auth.js `emailVerified` (ms epoch). Set when a magic-link is used; may be
    // null for OAuth users whose provider we trust for verification instead.
    email_verified: integer('email_verified', { mode: 'timestamp_ms' }),
    name: text('name'),
    // Maps to Auth.js `image` (the adapter aliases the two).
    avatar_url: text('avatar_url'),
    role: text('role').notNull(),
    last_login_at: text('last_login_at'),
    deleted_at: text('deleted_at'),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_users_email').on(t.email),
    index('idx_users_org').on(t.org_id),
    check('users_role_check', sql`${t.role} in ('owner', 'admin', 'editor', 'viewer')`),
  ],
)

// Auth.js OAuth/OIDC account links (one row per provider identity). Replaces
// the former `users.google_sub` column — identity is keyed by
// (provider, provider_account_id) here so a user can link multiple providers.
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'oauth' | 'oidc' | 'email' | 'webauthn'
    provider: text('provider').notNull(),
    provider_account_id: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'), // seconds epoch (provider-supplied)
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [
    uniqueIndex('idx_accounts_provider').on(t.provider, t.provider_account_id),
    index('idx_accounts_user').on(t.user_id),
  ],
)

// Auth.js email magic-link verification tokens. Consumed once on callback.
export const verification_token = sqliteTable(
  'verification_token',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: integer('expires', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

// --- 0002_auth ---------------------------------------------------------------

export const api_keys = sqliteTable(
  'api_keys',
  {
    id: text('id').primaryKey(), // keyId embedded in the token
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    secret_hash: text('secret_hash').notNull(), // SHA-256 of the secret half only
    scopes: text('scopes').notNull().default('[]'), // JSON array
    project_scope: text('project_scope'), // JSON array of project ids, or NULL for all
    expires_at: text('expires_at'),
    created_by: text('created_by')
      .notNull()
      .references(() => users.id),
    last_used_at: text('last_used_at'),
    revoked_at: text('revoked_at'), // soft revoke, keeps audit trail
    created_at: text('created_at').notNull(),
  },
  (t) => [index('idx_api_keys_org').on(t.org_id)],
)

// Append-only. Every mutating request writes one row inside the same D1 batch
// as the mutation itself.
export const audit_log = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id').notNull(),
    actor_id: text('actor_id'), // user id or api_key id; NULL for system
    actor_kind: text('actor_kind').notNull(),
    action: text('action').notNull(), // dotted verb, e.g. 'member.role_change'
    entity_type: text('entity_type').notNull(),
    entity_id: text('entity_id'),
    before: text('before'), // JSON snapshot (secrets redacted), nullable
    after: text('after'), // JSON snapshot (secrets redacted), nullable
    ip: text('ip'),
    user_agent: text('user_agent'),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    index('idx_audit_org_created').on(t.org_id, sql`${t.created_at} desc`),
    index('idx_audit_entity').on(t.entity_type, t.entity_id),
    index('idx_audit_actor').on(t.actor_id),
    check('audit_log_actor_kind_check', sql`${t.actor_kind} in ('user', 'api_key', 'system')`),
  ],
)

// --- 0003_projects -----------------------------------------------------------

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    source_repo: text('source_repo'), // owner/repo for AI flow-gen / on-merge (nullable)
    default_environment_id: text('default_environment_id'), // FK → environments (no constraint)
    slack_channel: text('slack_channel'), // 0006: default Slack channel for reports
    created_by: text('created_by')
      .notNull()
      .references(() => users.id),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    deleted_at: text('deleted_at'),
  },
  (t) => [
    // Slug is unique among live projects (soft-deleted rows free the slug).
    uniqueIndex('idx_projects_slug').on(t.org_id, t.slug).where(sql`${t.deleted_at} is null`),
    index('idx_projects_org').on(t.org_id),
  ],
)

export const environments = sqliteTable(
  'environments',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    base_url: text('base_url').notNull(),
    headers: text('headers').notNull().default('{}'), // JSON default headers
    secrets_ciphertext: text('secrets_ciphertext'), // AES-GCM of JSON {name:value}; never returned
    auth_config: text('auth_config'), // JSON optional pre-auth
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    deleted_at: text('deleted_at'),
  },
  (t) => [
    uniqueIndex('idx_environments_name')
      .on(t.project_id, t.name)
      .where(sql`${t.deleted_at} is null`),
    index('idx_environments_project').on(t.project_id),
  ],
)

export const flows = sqliteTable(
  'flows',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    description: text('description'),
    current_version_id: text('current_version_id'), // FK → flow_versions (no constraint)
    engines: text('engines').notNull().default('[]'), // JSON array: ["playwright","k6"]
    origin: text('origin').notNull().default('manual'),
    created_by: text('created_by')
      .notNull()
      .references(() => users.id),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
    deleted_at: text('deleted_at'),
  },
  (t) => [
    uniqueIndex('idx_flows_name').on(t.project_id, t.name).where(sql`${t.deleted_at} is null`),
    index('idx_flows_project').on(t.project_id),
    check('flows_origin_check', sql`${t.origin} in ('manual', 'recorder', 'ai')`),
  ],
)

// Immutable snapshots. `version` increments per flow; never updated after insert.
export const flow_versions = sqliteTable(
  'flow_versions',
  {
    id: text('id').primaryKey(),
    flow_id: text('flow_id')
      .notNull()
      .references(() => flows.id),
    version: integer('version').notNull(),
    steps: text('steps').notNull(), // JSON FlowStep[]
    load_profile: text('load_profile'), // JSON k6 stages/thresholds (nullable)
    author_id: text('author_id')
      .notNull()
      .references(() => users.id),
    diff_summary: text('diff_summary'),
    created_at: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_flow_versions_version').on(t.flow_id, t.version),
    index('idx_flow_versions_flow').on(t.flow_id, sql`${t.version} desc`),
  ],
)

// --- 0004_runs ---------------------------------------------------------------

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    environment_id: text('environment_id')
      .notNull()
      .references(() => environments.id),
    flow_selection: text('flow_selection').notNull().default('[]'), // JSON resolved selection
    engine: text('engine').notNull(),
    profile: text('profile').notNull().default('smoke'),
    status: text('status').notNull(),
    trigger: text('trigger').notNull(),
    triggered_by: text('triggered_by').references(() => users.id), // nullable for machine triggers
    expected_shards: integer('expected_shards').notNull().default(1),
    gha_run_id: text('gha_run_id'),
    commit_sha: text('commit_sha'),
    error: text('error'),
    summary: text('summary'), // JSON denormalized top-line metrics
    // 0005: attribute a run to the schedule that produced it (nullable).
    schedule_id: text('schedule_id').references(() => schedules.id),
    // 0006: channel a slash command came from, captured at trigger time.
    slack_channel: text('slack_channel'),
    queued_at: text('queued_at').notNull(),
    started_at: text('started_at'),
    finished_at: text('finished_at'),
  },
  (t) => [
    index('idx_runs_project_status').on(t.project_id, t.status, sql`${t.queued_at} desc`),
    index('idx_runs_org_queued').on(t.org_id, sql`${t.queued_at} desc`),
    index('idx_runs_status').on(t.status),
    index('idx_runs_schedule').on(t.schedule_id, sql`${t.queued_at} desc`),
    check('runs_engine_check', sql`${t.engine} in ('playwright', 'k6')`),
    check(
      'runs_status_check',
      sql`${t.status} in ('queued', 'running', 'passed', 'failed', 'cancelled')`,
    ),
    check('runs_trigger_check', sql`${t.trigger} in ('manual', 'slack', 'cron', 'merge', 'ci')`),
  ],
)

export const run_shards = sqliteTable(
  'run_shards',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id),
    shard_index: integer('shard_index').notNull(),
    status: text('status').notNull(),
    runner: text('runner'),
    public_ip: text('public_ip'),
    started_at: text('started_at'),
    finished_at: text('finished_at'),
  },
  (t) => [
    uniqueIndex('idx_run_shards_run_index').on(t.run_id, t.shard_index),
    check(
      'run_shards_status_check',
      sql`${t.status} in ('pending', 'running', 'passed', 'failed', 'errored')`,
    ),
  ],
)

export const shard_results = sqliteTable(
  'shard_results',
  {
    id: text('id').primaryKey(),
    run_id: text('run_id')
      .notNull()
      .references(() => runs.id),
    shard_id: text('shard_id')
      .notNull()
      .references(() => run_shards.id),
    flow_results: text('flow_results'), // JSON per-flow pass/fail, duration, failed step, error
    metrics: text('metrics'), // JSON k6 http metrics or Playwright timings/web vitals
    runtime_issues: text('runtime_issues'), // JSON console errors, failed requests, rejections
    events: text('events'), // JSON ordered step events (bounded)
    artifact_keys: text('artifact_keys'), // JSON R2 object keys
    created_at: text('created_at').notNull(),
  },
  (t) => [index('idx_shard_results_run').on(t.run_id)],
)

export const reports = sqliteTable('reports', {
  id: text('id').primaryKey(),
  run_id: text('run_id')
    .notNull()
    .unique()
    .references(() => runs.id),
  status: text('status').notNull(),
  totals: text('totals'), // JSON shards passed/failed, total duration
  load_summary: text('load_summary'), // JSON k6 p50/p95/p99, RPS, error rate, thresholds
  e2e_summary: text('e2e_summary'), // JSON flows passed/failed, first failing step
  html_report_key: text('html_report_key'), // R2 key of rendered HTML report (nullable)
  created_at: text('created_at').notNull(),
})

// --- 0005_schedules ----------------------------------------------------------

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    environment_id: text('environment_id')
      .notNull()
      .references(() => environments.id),
    flow_selection: text('flow_selection').notNull().default('["all"]'), // JSON names or ["all"]
    engine: text('engine').notNull(),
    profile: text('profile').notNull().default('smoke'),
    trigger_type: text('trigger_type').notNull(),
    cron_expr: text('cron_expr'), // for `cron` (nullable)
    watch_branch: text('watch_branch'), // for `on_merge`, e.g. "main"
    enabled: integer('enabled').notNull().default(1), // 0/1
    created_by: text('created_by').references(() => users.id),
    last_fired_at: text('last_fired_at'),
    next_due_at: text('next_due_at'), // for `cron`; computed from cron_expr
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_schedules_due').on(t.enabled, t.next_due_at),
    index('idx_schedules_project').on(t.project_id),
    index('idx_schedules_merge').on(t.trigger_type, t.enabled),
    check('schedules_engine_check', sql`${t.engine} in ('playwright', 'k6')`),
    check('schedules_trigger_type_check', sql`${t.trigger_type} in ('cron', 'on_merge')`),
  ],
)

// --- 0006_integrations -------------------------------------------------------

export const integrations = sqliteTable(
  'integrations',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    kind: text('kind').notNull(),
    external_id: text('external_id'), // Slack team id / GitHub installation id
    config_ciphertext: text('config_ciphertext').notNull(), // encrypted JSON of tokens/secrets
    created_by: text('created_by').references(() => users.id),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_integrations_org_kind').on(t.org_id, t.kind), // one per kind per org
    check('integrations_kind_check', sql`${t.kind} in ('slack', 'github')`),
  ],
)

// --- 0007_ai -----------------------------------------------------------------

export const ai_providers = sqliteTable(
  'ai_providers',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    model: text('model').notNull(),
    api_key_ciphertext: text('api_key_ciphertext'), // encrypted; nullable for workers_ai
    created_by: text('created_by').references(() => users.id),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_ai_providers_org').on(t.org_id),
    check('ai_providers_name_check', sql`${t.name} in ('anthropic', 'openai', 'workers_ai')`),
  ],
)

export const ai_analyses = sqliteTable(
  'ai_analyses',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    provider_id: text('provider_id').references(() => ai_providers.id),
    ref: text('ref'), // git ref analyzed (default branch if null)
    status: text('status').notNull(),
    error: text('error'),
    draft_count: integer('draft_count').notNull().default(0),
    gha_run_id: text('gha_run_id'),
    created_by: text('created_by').references(() => users.id),
    created_at: text('created_at').notNull(),
    finished_at: text('finished_at'),
  },
  (t) => [
    index('idx_ai_analyses_project').on(t.project_id, sql`${t.created_at} desc`),
    check(
      'ai_analyses_status_check',
      sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`,
    ),
  ],
)

export const flow_drafts = sqliteTable(
  'flow_drafts',
  {
    id: text('id').primaryKey(),
    org_id: text('org_id')
      .notNull()
      .references(() => organization.id),
    project_id: text('project_id')
      .notNull()
      .references(() => projects.id),
    analysis_id: text('analysis_id').references(() => ai_analyses.id),
    name: text('name').notNull(),
    description: text('description'),
    engines: text('engines').notNull().default('["playwright"]'), // JSON array
    steps: text('steps').notNull(), // JSON FlowStep[]
    load_profile: text('load_profile'), // JSON (nullable)
    reasoning: text('reasoning'), // model's rationale
    source_refs: text('source_refs'), // JSON files/routes referenced
    status: text('status').notNull().default('draft'),
    origin: text('origin').notNull().default('ai'),
    approved_flow_id: text('approved_flow_id').references(() => flows.id),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (t) => [
    index('idx_flow_drafts_project').on(t.project_id, t.status, sql`${t.created_at} desc`),
    check('flow_drafts_status_check', sql`${t.status} in ('draft', 'approved', 'rejected')`),
  ],
)

// Aggregate export used to build the Drizzle client (`drizzle(d1, { schema })`).
export const schema = {
  organization,
  users,
  accounts,
  verification_token,
  api_keys,
  audit_log,
  projects,
  environments,
  flows,
  flow_versions,
  runs,
  run_shards,
  shard_results,
  reports,
  schedules,
  integrations,
  ai_providers,
  ai_analyses,
  flow_drafts,
}
