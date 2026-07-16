# Data Model (D1)

Cloudflare D1 is SQLite, so the schema is relational with foreign keys and JSON columns where a value is inherently document-shaped (step lists, result blobs). This document describes entities, relationships, and the audit design. Column types are SQLite affinities; `TEXT` timestamps are ISO-8601 UTC.

## Conventions

- Primary keys are `TEXT` UUIDv7-style ids (sortable by creation time) unless noted.
- `created_at` / `updated_at` on every mutable table.
- Every row that belongs to the organization carries `org_id` (nullable, single value for v1) so multi-org is a later data migration, not a schema rewrite.
- Soft deletes via `deleted_at` on user-facing entities; runs and audit rows are never deleted.
- JSON blobs are validated at the API boundary (Zod) before insert.

## Entity overview

```
organization
  └── users ──< sessions
  └── projects ──< environments
                └──< flows ──< flow_versions
                └──< schedules
                └──< runs ──< run_shards ──< shard_results
                          └── reports
  └── api_keys
  └── integrations (slack_install, github_install)
  └── ai_providers
  └── audit_log
```

## Tables

### organization
Single row in v1 (self-host, single org). Holds global settings.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| name | TEXT | |
| allowed_email_domains | TEXT (JSON array) | Google SSO allow-list, e.g. `["example.com"]` |
| default_ai_provider_id | TEXT FK → ai_providers | nullable |
| settings | TEXT (JSON) | misc org settings |
| created_at / updated_at | TEXT | |

### users
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| org_id | TEXT FK | |
| email | TEXT UNIQUE | from Google |
| name | TEXT | |
| avatar_url | TEXT | |
| role | TEXT | `owner` \| `admin` \| `editor` \| `viewer` |
| google_sub | TEXT UNIQUE | OIDC subject |
| last_login_at | TEXT | |
| created_at / updated_at | TEXT | |

### sessions
| column | type | notes |
|---|---|---|
| id | TEXT PK | opaque session id (cookie value is a hash) |
| user_id | TEXT FK | |
| user_agent / ip | TEXT | for the audit trail |
| expires_at | TEXT | |
| created_at | TEXT | |

### projects
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| org_id | TEXT FK | |
| name | TEXT | |
| slug | TEXT UNIQUE | used in Slack commands and URLs |
| description | TEXT | |
| source_repo | TEXT | `owner/repo` for AI flow-gen and on-merge triggers (nullable) |
| default_environment_id | TEXT FK → environments | nullable |
| created_by | TEXT FK → users | |
| created_at / updated_at / deleted_at | TEXT | |

### environments
An environment is a target: where a run points.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT FK | |
| name | TEXT | `dev`, `qa`, `staging`, `prod`, … (unique per project) |
| base_url | TEXT | |
| headers | TEXT (JSON) | default headers injected into runs |
| secrets_ciphertext | TEXT | encrypted JSON of secret key/values (never returned to client) |
| auth_config | TEXT (JSON) | optional pre-auth (login flow ref or token endpoint) |
| created_at / updated_at | TEXT | |

### flows
The current pointer for a named flow; the body lives in `flow_versions`.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT FK | |
| name | TEXT | unique per project |
| description | TEXT | |
| current_version_id | TEXT FK → flow_versions | |
| engines | TEXT (JSON array) | which engines this flow supports: `["playwright","k6"]` |
| origin | TEXT | `manual` \| `recorder` \| `ai` |
| created_by | TEXT FK → users | |
| created_at / updated_at / deleted_at | TEXT | |

### flow_versions
Immutable snapshots — the audit/versioning backbone for flows.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| flow_id | TEXT FK | |
| version | INTEGER | monotonically increasing per flow |
| steps | TEXT (JSON) | the `FlowStep[]` definition (see TEST_ENGINES.md) |
| load_profile | TEXT (JSON) | k6 stages/VUs/thresholds (nullable) |
| author_id | TEXT FK → users | |
| diff_summary | TEXT | human-readable change summary vs previous |
| created_at | TEXT | never updated |

### schedules
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| project_id | TEXT FK | |
| environment_id | TEXT FK | |
| flow_selection | TEXT (JSON) | flow ids or `"all"` |
| engine | TEXT | `playwright` \| `k6` |
| profile | TEXT | `smoke` \| `load` \| `stress` (k6) |
| trigger_type | TEXT | `cron` \| `on_merge` |
| cron_expr | TEXT | for `cron` (nullable) |
| watch_branch | TEXT | for `on_merge`, e.g. `main` (nullable) |
| enabled | INTEGER (bool) | |
| created_by | TEXT FK → users | |
| last_fired_at / next_due_at | TEXT | |
| created_at / updated_at | TEXT | |

### runs
| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| project_id / environment_id | TEXT FK | |
| flow_selection | TEXT (JSON) | resolved flow+version ids |
| engine | TEXT | `playwright` \| `k6` |
| profile | TEXT | |
| status | TEXT | `queued` \| `running` \| `passed` \| `failed` \| `cancelled` |
| trigger | TEXT | `manual` \| `slack` \| `cron` \| `merge` \| `ci` |
| triggered_by | TEXT FK → users | nullable for machine triggers |
| expected_shards | INTEGER | matrix size |
| gha_run_id | TEXT | dispatched GitHub workflow run id (for reconcile/cancel) |
| commit_sha | TEXT | source commit under test (nullable) |
| queued_at / started_at / finished_at | TEXT | |
| summary | TEXT (JSON) | denormalized top-line metrics for list views |

### run_shards
One row per matrix job (1 VU for E2E, or one k6 slice).

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| run_id | TEXT FK | |
| shard_index | INTEGER | |
| status | TEXT | `pending` \| `running` \| `passed` \| `failed` \| `errored` |
| runner | TEXT | runner label/host |
| public_ip | TEXT | egress evidence |
| started_at / finished_at | TEXT | |

### shard_results
Per-shard structured output. Large artifacts go to R2; this holds metrics + pointers.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| run_id / shard_id | TEXT FK | |
| flow_results | TEXT (JSON) | pass/fail, duration, failed step, error per flow |
| metrics | TEXT (JSON) | k6 http metrics or Playwright timings, web vitals |
| runtime_issues | TEXT (JSON) | console errors, failed requests, unhandled rejections |
| events | TEXT (JSON) | ordered step events (bounded; overflow → R2) |
| artifact_keys | TEXT (JSON) | R2 object keys: screenshots, video, trace, HAR |
| created_at | TEXT | |

### reports
Aggregated, final view of a run — what the dashboard and Slack render.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| run_id | TEXT FK UNIQUE | |
| status | TEXT | terminal status |
| totals | TEXT (JSON) | shards passed/failed, total duration |
| load_summary | TEXT (JSON) | k6 p50/p95/p99, RPS, error rate, thresholds pass/fail |
| e2e_summary | TEXT (JSON) | flows passed/failed, first failing step |
| html_report_key | TEXT | R2 key of the rendered HTML report (nullable) |
| created_at | TEXT | |

### api_keys
For CI callers and machine access. Never store plaintext.

| column | type | notes |
|---|---|---|
| id | TEXT PK | key id embedded in the token |
| org_id | TEXT FK | |
| name | TEXT | |
| secret_hash | TEXT | SHA-256 of the secret half |
| scopes | TEXT (JSON array) | e.g. `["runs:write","runs:read"]` |
| project_scope | TEXT (JSON) | optional project id allow-list |
| expires_at | TEXT | nullable |
| created_by | TEXT FK → users | |
| last_used_at | TEXT | |
| revoked_at | TEXT | nullable |
| created_at | TEXT | |

Token format: `charlie_{env}_{keyId}_{secret}`. Only `secret_hash` is stored.

### integrations
Rows for Slack and GitHub installs.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| org_id | TEXT FK | |
| kind | TEXT | `slack` \| `github` |
| external_id | TEXT | Slack team id / GitHub installation id |
| config_ciphertext | TEXT | tokens/signing secrets encrypted at rest |
| created_by | TEXT FK → users | |
| created_at / updated_at | TEXT | |

### ai_providers
Pluggable AI config (bring your own key).

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| org_id | TEXT FK | |
| provider | TEXT | `anthropic` \| `openai` \| `workers_ai` |
| model | TEXT | e.g. `claude-sonnet-...`, `gpt-...` |
| api_key_ciphertext | TEXT | encrypted; `workers_ai` needs none |
| enabled | INTEGER (bool) | |
| created_by | TEXT FK → users | |
| created_at / updated_at | TEXT | |

### audit_log
Append-only. The "who did what" record.

| column | type | notes |
|---|---|---|
| id | TEXT PK | |
| org_id | TEXT FK | |
| actor_id | TEXT FK → users | nullable for machine actors |
| actor_kind | TEXT | `user` \| `api_key` \| `system` |
| action | TEXT | e.g. `flow.update`, `schedule.create`, `run.trigger`, `member.role_change` |
| entity_type | TEXT | `flow`, `environment`, `run`, … |
| entity_id | TEXT | |
| before | TEXT (JSON) | prior state (nullable for creates) |
| after | TEXT (JSON) | new state (nullable for deletes) |
| ip / user_agent | TEXT | |
| created_at | TEXT | |

## Indexing notes

- `runs(project_id, status, queued_at DESC)` — run lists and queue views.
- `run_shards(run_id, shard_index)` — shard aggregation.
- `flow_versions(flow_id, version DESC)` — history view.
- `audit_log(org_id, created_at DESC)` and `audit_log(entity_type, entity_id)` — audit browsing and per-entity history.
- `schedules(enabled, next_due_at)` — cron sweep.

## Encryption

`*_ciphertext` columns store AES-GCM ciphertext. The key-encryption key lives in Workers Secrets (`CHARLIE_KEK`), never in D1. Plaintext secrets are only ever decrypted server-side and injected into dispatched runs; they are never serialized back to the client.

## Migrations

Managed with Wrangler D1 migrations (`migrations/NNNN_description.sql`), applied in CI on deploy. Every schema change is a forward migration; destructive changes ship with a data-preserving path.
