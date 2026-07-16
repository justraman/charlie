# Architecture

System design for Charlie. For the product overview see [README.md](README.md). For the build sequence see [EXECUTION_PLAN.md](EXECUTION_PLAN.md).

## Design principle: control plane vs compute plane

Charlie separates two concerns that scale and fail differently:

- **Control plane (Cloudflare).** Holds all durable state, authenticates users, coordinates runs, stores reports, and serves the UI. It is cheap, always-on, globally distributed, and never runs a browser. Cloudflare Workers have strict CPU-time limits, so the Worker orchestrates but never executes tests.
- **Compute plane (GitHub Actions).** Runs the actual browsers (Playwright) and load generators (k6). It is ephemeral, horizontally scalable via the Actions matrix, and reports back to the control plane over authenticated HTTP.

This split is the single most important thing to understand. Every feature decision follows from it: state lives on Cloudflare, execution lives on GitHub, and they talk over a small, authenticated API.

## Control plane components (Cloudflare)

### Worker (Hono)
A single Worker serves both the SPA and the REST API, mirroring the "one origin" model:

- Static assets (the built React SPA) via [Workers Assets](https://developers.cloudflare.com/workers/static-assets/).
- REST API mounted under `/api/*` using Hono.
- Google OAuth callback and session management.
- Webhook receivers for GitHub (`/webhooks/github`) and Slack (`/slack/*`).
- Server-Sent Events for live run progress (`/api/runs/:id/events`), backed by the run's Durable Object.

Every protected route passes through one middleware that authenticates (session cookie or API key), authorizes (RBAC scope), and rate-limits.

### D1 (SQLite) — system of record
Relational store for everything durable: users, sessions, projects, environments, flows and their versions, runs and per-VU results, reports, schedules, integrations, API keys, and the audit log. Schema in [docs/DATA_MODEL.md](docs/DATA_MODEL.md).

D1 is the source of truth. The dashboard renders D1-derived responses; it never computes aggregates client-side.

### Durable Objects — per-run coordination
D1 is eventually-consistent-ish and awkward for high-frequency, strongly-consistent counters. Each active run gets a **Run Coordinator DO**:

- Tracks which VUs/shards have checked in and their latest status.
- Aggregates per-VU results into a running summary.
- Fans out live progress to connected SSE/WebSocket clients.
- Enforces the dead-VU timeout (if a runner dies without posting, the DO marks it failed after a grace period).
- On completion, writes the final report to D1 and enqueues post-run actions (Slack notify, etc.).

A second **Scheduler DO** (or the Cron handler directly) serializes schedule evaluation so a cron tick never double-dispatches.

### Queues — dispatch decoupling
`POST /api/runs` writes a `queued` run to D1 and enqueues a message on a Cloudflare Queue. A queue consumer obtains a GitHub App installation token and calls `workflow_dispatch`. This decouples "user asked for a run" from "GitHub accepted the dispatch," giving retries and backpressure for free.

### Cron Triggers — scheduled runs
The Worker's `scheduled` handler runs on Cloudflare Cron. On each tick it reads due `schedules` from D1 and enqueues runs. Interval scheduling ("every 15 min", "daily 09:00 UTC") is expressed as cron expressions stored per schedule.

### R2 — large artifacts
Screenshots, videos, Playwright traces, HAR files, k6 JSON summaries, and generated HTML reports are too big for D1. They live in R2. Runners upload directly to R2 via **presigned PUT URLs** issued by the Worker (so runner tokens never see R2 credentials). D1 stores the R2 object keys.

### KV (optional)
Short-lived, read-heavy caches (OAuth state, rate-limit counters, Slack signing nonces) may use Workers KV. Not a system of record.

## Compute plane components (GitHub Actions)

### Charlie runner repo + reusable workflow
Charlie owns one GitHub repository containing a **reusable workflow** (`.github/workflows/charlie-run.yml`). The Worker dispatches it with inputs describing the run. The workflow has three job stages:

1. **prepare** — validates inputs, resolves the flow bundle, computes the matrix (`[0..N-1]`).
2. **execute** (matrix, `fail-fast: false`) — each job runs one shard:
   - **Playwright E2E:** one browser context per shard, executes the flow's steps, captures screenshots/trace on failure, POSTs a per-shard result.
   - **k6 load:** each job runs a k6 scenario with a slice of the total VUs (k6 drives many protocol-level VUs per runner, so load uses *few* jobs × *many* VUs, unlike E2E).
3. **finalize** (`if: always()`) — posts a completion sentinel so the Run Coordinator DO can close the run even if a shard died.

### GitHub App
A GitHub App (installed on the org and on watched source repos) provides:

- **Workflow dispatch** into the runner repo (installation token, minted per dispatch).
- **Merge webhooks** — `push` / `pull_request.closed(merged)` events from watched repos hit `/webhooks/github`, triggering on-merge runs.
- **Source access** — read-only repo contents for the AI flow-generation job.

See [docs/CI_INTEGRATION.md](docs/CI_INTEGRATION.md).

## Run lifecycle

```
queued → running → passed | failed | cancelled
```

1. **queued** — a trigger (UI, Slack, cron, or merge webhook) calls `POST /api/runs`. The Worker validates, resolves project + environment + flow selection + engine + profile, writes a `RunRecord`, and enqueues a dispatch message. The run's Coordinator DO is created.
2. **dispatch** — the queue consumer mints a GitHub App token and `workflow_dispatch`es the reusable workflow with `{ runId, projectId, environmentId, engine, flows, vus, profile, callbackUrl, runToken }`. `runToken` is a short-lived, run-scoped bearer token. The dispatched GitHub run id is stored on the record for reconciliation and cancellation.
3. **running** — the first shard to POST `/api/runs/:id/shard-result` (via the DO) flips the run to `running`. Each shard streams structured events and its per-flow results, and uploads artifacts to R2 via presigned URLs.
4. **passed / failed** — when all expected shards report (or `finalize` posts, or the DO timeout fires), the DO aggregates, derives terminal status against the flow's thresholds, writes the report to D1, and triggers post-run notifications.
5. **cancelled** — `POST /api/runs/:id/cancel` removes a still-queued run, or best-effort cancels the in-flight GitHub workflow run via the GitHub API, then broadcasts the state change.

Reconciliation: if shards or finalize never post, a periodic Cron sweep queries the GitHub API for terminal workflow state and closes orphaned runs.

## Data flow: triggering a run from Slack

```
QA types /charlie run checkout --env qa
        │
        ▼
Slack ── POST /slack/commands ──▶ Worker (verify signature)
        │                          resolve project/env/flow, RBAC check
        │                          POST-equivalent create run + enqueue
        ▼
Cloudflare Queue ──▶ dispatch consumer ──▶ GitHub workflow_dispatch
        │
        ▼
GitHub Actions matrix runs Playwright/k6
        │  shard-result + artifacts
        ▼
Worker + Run Coordinator DO aggregate ──▶ D1 report
        │
        ▼
Worker posts result summary back to the Slack channel
```

## Environments and targeting

A **project** has many **environments**. Each environment carries:

- `base_url` (e.g. `https://qa.example.com`)
- default request headers and cookies
- secrets (encrypted at rest; injected into runs, never returned to the client)
- optional pre-auth config (login flow or token acquisition)

A run always targets exactly one `(project, environment, engine, flow-selection, profile)`. This is how "target based on qa, dev, or any environment" is expressed.

## Flows and versioning

A **flow** is an engine-agnostic sequence of steps (`goto`, `click`, `fill`, `waitFor`, `assert`, `extract`, …). Flows are **versioned**: every save creates a `flow_version` with the author, timestamp, and a diff against the prior version. E2E runs execute the flow directly in Playwright; load runs compile the flow's navigations/requests into a k6 HTTP scenario with a load profile (stages, VUs, thresholds). See [docs/TEST_ENGINES.md](docs/TEST_ENGINES.md).

## Security model

- **Login:** Google SSO (OIDC), restricted to configured email domains. Sessions are httpOnly cookies backed by D1.
- **RBAC:** roles `owner`, `admin`, `editor`, `viewer`. Enforced in the single protected-route middleware.
- **Audit:** every mutating request records `{ actor, action, entity_type, entity_id, before, after, ip, ts }` to `audit_log`. Immutable (append-only).
- **Machine auth:** CI/runner callbacks use scoped, hashed API keys or short-lived run tokens. Secrets and provider API keys are encrypted at rest with a key held in Workers Secrets.

Details in [docs/AUTH.md](docs/AUTH.md).

## Why not run tests on Cloudflare?

Workers cannot launch a browser and are CPU/time-bounded — unsuitable for Playwright or sustained k6 load. GitHub Actions gives real Linux VMs, a browser-capable environment, natural parallelism via the matrix, and a billing model teams already understand. Cloudflare's job is coordination and state, which it does extremely well and cheaply. This is the same control/compute split the reference project used (Cloudflare in place of a Hono-on-Bun server + Redis; GitHub Actions unchanged).

## Deferred / future

- Self-hosted GitHub runners (per-project runner labels).
- Multi-organization (SaaS) mode — schema leaves room via a nullable `org_id`.
- Browser-based load (real browsers at scale) as an additional engine.
- Scheduled report digests and regression baselines.
