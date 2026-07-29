# API Reference

REST API served by the Worker under `/api/*`. All responses are JSON. Auth is a session cookie (browser) or `Authorization: Bearer <apiKey|runToken>` (machines). Mutating routes are audited.

Conventions: `200` success, `201` created, `202` accepted (async), `400` validation (Zod), `401` unauthenticated, `403` scope/role, `404` missing, `409` conflict, `429` rate-limited. Errors: `{ "error": { "code", "message", "details?" } }`.

## Auth

| Method | Path | Scope/Role | Purpose |
|---|---|---|---|
| GET | `/api/auth/google/start` | public | Begin Google OIDC |
| GET | `/api/auth/google/callback` | public | OIDC callback → session |
| POST | `/api/auth/logout` | session | End session |
| GET | `/api/auth/me` | session | Current user + role |

## Members (admin+)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/members` | List users |
| PATCH | `/api/members/:id` | Change role (audited) |
| DELETE | `/api/members/:id` | Deactivate (audited) |

## API keys (admin+)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/api-keys` | List (no secrets) |
| POST | `/api/api-keys` | Create; returns plaintext once (audited) |
| DELETE | `/api/api-keys/:id` | Revoke (audited) |

## Projects & environments

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/projects` | viewer | List projects |
| POST | `/api/projects` | editor | Create (audited) |
| GET | `/api/projects/:id` | viewer | Detail |
| PATCH | `/api/projects/:id` | editor | Update (audited) |
| DELETE | `/api/projects/:id` | admin | Soft-delete (audited) |
| GET | `/api/projects/:id/environments` | viewer | List envs |
| POST | `/api/projects/:id/environments` | editor | Create env (audited) |
| PATCH | `/api/environments/:id` | editor | Update; secrets require admin (audited) |
| DELETE | `/api/environments/:id` | admin | Delete (audited) |

Environment responses mask secrets (`{ "SECRET_NAME": "•••set" }`); plaintext is never returned.

## Flows

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/projects/:id/flows` | viewer | List flows |
| POST | `/api/projects/:id/flows` | editor | Create flow + v1 (audited) |
| GET | `/api/flows/:id` | viewer | Current version |
| PUT | `/api/flows/:id` | editor | New version (audited, diff stored) |
| GET | `/api/flows/:id/versions` | viewer | Version history |
| GET | `/api/flows/:id/versions/:v` | viewer | A specific version |
| DELETE | `/api/flows/:id` | editor | Soft-delete (audited) |

### Import & export

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/projects/:id/flows/export` | viewer | Download the project's flows as a `charlie.flows/v1` document (`?flowIds=a,b`, `?deps=0`) |
| GET | `/api/flows/:id/export` | viewer | Download one flow + its `useFlow` dependencies (`?deps=0`) |
| POST | `/api/projects/:id/flows/import` | editor | Upload a document (audited); `?mode=create\|upsert`, `?dryRun=1` |

Import body is either the bare document or `{ document, mode?, dryRun? }`.
`dryRun` validates and returns the plan without writing. Validation failures are
`400` with one `details` entry per problem, each carrying a JSON path;
name clashes under `mode=create` are `409`. See
[FLOW_IMPORT_EXPORT.md](FLOW_IMPORT_EXPORT.md).

## Runs

| Method | Path | Role/Scope | Purpose |
|---|---|---|---|
| POST | `/api/runs` | editor / `runs:write` | Create + enqueue a run (202, audited) |
| GET | `/api/runs` | viewer / `runs:read` | List (filter by project/env/status) |
| GET | `/api/runs/:id` | viewer / `runs:read` | Run detail |
| GET | `/api/runs/:id/events` | viewer | SSE live progress (via Run DO) |
| POST | `/api/runs/:id/cancel` | editor | Cancel (audited) |
| POST | `/api/runs/bulk-cancel` | editor | Bulk cancel (202, per-entry result) |

### Machine callbacks (runToken)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/runs/:id/shard-result` | Per-shard result + events; first flips run to `running` |
| POST | `/api/runs/:id/artifacts/presign` | Get presigned R2 PUT URL for an artifact key |
| POST | `/api/runs/:id/finalize` | Completion sentinel (always posted) |

Create-run body:
```jsonc
{
  "project": "storefront",        // id or slug
  "environment": "qa",            // id or name
  "engine": "playwright",         // or "k6"
  "flows": ["checkout"],          // omit or ["all"] for every flow
  "profile": "smoke"              // k6 only; ignored for playwright
}
```

## Reports

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/runs/:id/report` | viewer / `reports:read` | Aggregated report |
| GET | `/api/reports` | viewer | Recent reports (project/env filters) |
| GET | `/api/reports/:id/artifacts/:key` | viewer | Signed R2 URL for an artifact |

## Schedules

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/projects/:id/schedules` | viewer | List |
| POST | `/api/projects/:id/schedules` | editor | Create cron/on-merge schedule (audited) |
| PATCH | `/api/schedules/:id` | editor | Update / enable / disable (audited) |
| DELETE | `/api/schedules/:id` | editor | Delete (audited) |

## Integrations (read-only)

Slack and GitHub credentials come from Worker secrets, never the DB, so there is
nothing to create or update over the API.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/integrations` | viewer | Live connection status (`?refresh=1` bypasses the 60s KV cache). No secrets returned. |

## Webhooks & Slack (public, signature-verified)

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks/github` | GitHub App events (on-merge triggers) |
| POST | `/slack/commands` | Slash command entrypoint |
| POST | `/slack/interactivity` | Button actions (re-run, view report) |

## Audit

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/audit` | admin | Global audit log (filters: actor, action, entity, date) |
| GET | `/api/audit/:entityType/:entityId` | admin | History for one entity |
