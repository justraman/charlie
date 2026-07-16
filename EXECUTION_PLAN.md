# Execution Plan

The build sequence for Charlie, from empty repo to open-source release. Each phase has **goals**, **tasks**, **deliverables**, and **acceptance criteria** (a phase is done only when its criteria pass). Phases are ordered so that each produces something demonstrable and the risky, load-bearing parts (auth, the control/compute handshake) come early.

Estimates assume a small team (1–2 engineers). They are planning aids, not commitments.

---

## Guiding constraints

- **Control plane = Cloudflare, compute plane = GitHub Actions.** No test ever runs in a Worker.
- **D1 is the system of record.** The UI renders server-derived responses; no client-side aggregation.
- **Everything mutating is audited.** Wire the audit helper before building CRUD, not after.
- **Ship demonstrable slices.** Prefer one end-to-end path working (trigger → GHA → report) over many half-built features.
- **Self-host, single org** is the v1 target; leave `org_id` in place for a future multi-org migration.

---

## Phase 0 — Foundations & walking skeleton

**Goal:** a deployable Worker serving an empty SPA, D1 wired, CI green, and the repo scaffolded as a monorepo.

**Tasks**
- Monorepo layout: `apps/web` (Vue SPA + Worker), `packages/flow-core`, `packages/runner` (GHA CLI), `migrations/`, `docs/`.
- Tooling: TypeScript, Biome (lint/format), Wrangler config (`wrangler.toml`) with bindings for D1, R2, Queues, KV, Durable Objects, Cron.
- D1: create database, first migration (`0001_init.sql`) with `organization`, `users`, `sessions`.
- Hono Worker skeleton: `/api/health`, static asset serving, one `/api/auth/me` stub.
- CI (GitHub Actions): lint, typecheck, `wrangler deploy --dry-run`, D1 migration check.
- LICENSE (Apache-2.0 or MIT — decide before public release), CONTRIBUTING, issue templates.
- `.dev.vars` template and `.env.example` documenting all secrets/bindings.

**Deliverables:** deployable Worker, migrations runner, CI pipeline, repo docs.

**Acceptance**
- `wrangler dev` serves the SPA shell and `/api/health` returns `200`.
- `wrangler d1 migrations apply` runs cleanly locally and against a remote D1.
- CI passes on a PR.

---

## Phase 1 — Auth, RBAC & audit

**Goal:** real Google SSO login, roles enforced, and the audit log operational — the security spine everything else hangs on.

**Tasks**
- Google OIDC: `/api/auth/google/start`, `/callback`; ID-token validation via Google JWKS; PKCE + `state` in KV.
- Domain gate against `organization.allowed_email_domains`; first user → `owner`.
- Sessions in D1; httpOnly cookie (hash of session id); sliding expiry; logout.
- Protected-route middleware: authenticate (session or API key) → authorize (role/scope) → rate-limit.
- Audit helper: `audit(actor, action, entity, before, after, ctx)` committed in the same D1 transaction as the mutation; secret redaction.
- Members API + API keys API (create/revoke, hashed secrets).
- SPA: login screen, auth guard, "who am I" header, members admin page.

**Deliverables:** working SSO, RBAC matrix, audit log, members + API-key management.

**Acceptance**
- A user from an allowed domain logs in; a disallowed domain is rejected and the rejection is audited.
- A `viewer` is blocked (403) from a mutating route; an `editor` succeeds and the action appears in `audit_log` with before/after.
- An API key authenticates a machine request at its scopes; a revoked key returns 401.

**Risks:** OIDC validation subtleties (clock skew, JWKS rotation). Mitigate with a tested token-verification module and a fixture-based unit suite.

---

## Phase 2 — Projects, environments & flow authoring

**Goal:** model the domain — projects, environments (targeting), and versioned flows — with a usable editor.

**Tasks**
- Migrations for `projects`, `environments`, `flows`, `flow_versions`.
- CRUD APIs per [API.md](docs/API.md), all audited; environment secrets encrypted (AES-GCM, KEK from Workers Secrets) and never returned in plaintext.
- `packages/flow-core`: the `FlowStep` schema (Zod), step types, placeholder resolution (`{{secrets.*}}`, `{{vars.*}}`), and the shared step-executor skeleton + `actionRegistry`.
- SPA: project list/detail, environment editor (with masked secrets), flow editor (step list add/edit/reorder), flow version history + diff view.

**Deliverables:** full project/env/flow management; flow-core package; versioning with diffs.

**Acceptance**
- Create a project with `dev`/`qa` environments; secrets set but never returned in API responses.
- Author a flow, edit it twice → three `flow_versions` with author + diff; history renders.
- Flow JSON validates against the schema; invalid steps are rejected with a 400.

---

## Phase 3 — Execution plane: the control/compute handshake (E2E first)

**Goal:** the load-bearing integration — trigger a run on Cloudflare, execute Playwright on GitHub Actions, stream results back, store a report. This is the highest-risk phase; do it before load, scheduling, Slack, or AI.

**Tasks**
- GitHub App: register, store private key + webhook secret in Workers Secrets, installation-token minting module.
- Charlie runner repo + `charlie-run.yml` reusable workflow (prepare → execute matrix → finalize).
- `packages/runner` CLI: `fetch-flow`, `execute` (Playwright engine using flow-core), `finalize`. Posts `shard-result`, uploads artifacts to R2 via presigned URLs.
- Worker: `POST /api/runs` → D1 `queued` + Cloudflare Queue enqueue.
- Queue consumer: mint token → `workflow_dispatch` → resolve + store `gha_run_id`.
- Run Coordinator Durable Object: shard check-in, aggregation, dead-shard timeout, SSE fan-out, terminal report write to D1 + `reports`.
- Machine-callback routes (run-token auth): `shard-result`, `artifacts/presign`, `finalize`.
- R2 wiring: presigned PUT; artifact key layout `runs/{runId}/{shard}/{name}`.
- SPA: run detail page with live SSE progress; artifact viewer (screenshots/trace links).

**Deliverables:** end-to-end Playwright run from dashboard to stored report with artifacts and live progress.

**Acceptance**
- Trigger an E2E run from the UI → a GitHub workflow dispatches → shards post back → run reaches `passed`/`failed` → report + screenshots visible.
- Kill a shard mid-run → DO timeout closes the run without hanging; `finalize` still records completion.
- Cancel a queued run (de-queued) and a running run (GitHub workflow cancelled).

**Risks:** dispatch→run-id resolution race, run-token scoping, R2 presign correctness. Mitigate with an integration test that drives a real (small) workflow against a staging Worker.

---

## Phase 4 — Load engine (k6)

**Goal:** the same flow runs as a k6 HTTP load test with profiles and thresholds.

**Tasks**
- Flow → k6 scenario compiler in flow-core (navigations→requests, fills→bodies, extracts→token capture, waits→think-time).
- k6 entrypoint bundling (esbuild → plain JS; k6 can't import Node at runtime).
- `packages/runner` k6 engine: run k6 with the compiled scenario + `loadProfile`, parse the JSON summary, post metrics.
- Profiles (`smoke`/`load`/`stress`) as named stage/threshold presets; per-flow override.
- Worker sizes k6 matrix (few jobs × many VUs) vs Playwright sizing.
- Report: `load_summary` (p50/p95/p99, RPS, error rate, thresholds pass/fail).
- SPA: load report view (metric cards, threshold pass/fail, latency chart).

**Deliverables:** k6 load runs with profiles, thresholds deciding pass/fail, load report UI.

**Acceptance**
- Run `checkout` as `load` against `qa`; report shows percentiles and RPS; a breached threshold fails the run and names the offending metric.
- The same flow definition runs as both Playwright (Phase 3) and k6 without edits.

---

## Phase 5 — Scheduling & triggers

**Goal:** runs fire automatically on an interval and on source-repo merges.

**Tasks**
- Migration for `schedules`.
- Cloudflare Cron Trigger + `scheduled` handler: select due schedules, enqueue, advance `next_due_at`; Scheduler DO (or conditional D1 update) for once-only dispatch.
- GitHub webhook receiver `/webhooks/github`: verify signature, match repo+branch to `on_merge` schedules, enqueue with `commit_sha` + `trigger = merge`.
- SPA: schedule management (cron builder, branch watcher), "next run" display, schedule run history.

**Deliverables:** cron and on-merge triggers, schedule management UI.

**Acceptance**
- A cron schedule (e.g. every 15 min) fires within one tick of its due time, exactly once per tick.
- A merge to a watched branch on the source repo produces a run tagged with the merge commit.
- Disabling a schedule stops future runs immediately.

---

## Phase 6 — Slack integration

**Goal:** trigger and receive runs from Slack.

**Tasks**
- Single-workspace Slack app; store credentials in `integrations` (encrypted).
- Request signature verification (timestamp window + HMAC) and 3-second ack pattern (ack now, work async).
- `/charlie` command parser (`run`/`e2e`/`load`/`status`/`last`/`help`); Slack-user→Charlie-user mapping by verified email; role gate; audit with `trigger = slack`.
- Interactivity endpoint (re-run, view report buttons).
- Post-run reporter: Block Kit result messages to the originating (and per-project default) channel; signed screenshot links; threshold breach details.

**Deliverables:** slash commands, identity mapping, result messages with actions.

**Acceptance**
- `/charlie run checkout --env qa` acks in <3s and posts a pass/fail summary when done.
- A Slack user without `editor` is refused and told how to get access; the attempt is audited.
- Scheduled/merge runs post to the project's default channel.

---

## Phase 7 — AI-assisted flow generation

**Goal:** draft flows from source code via a pluggable provider.

**Tasks**
- `ai_providers` config + Settings UI (provider, model, encrypted key); default provider.
- `AiProvider` interface + adapters: Anthropic, OpenAI, Workers AI.
- `ai-analyze` GitHub workflow: checkout source (App `contents: read`), static surface extraction (routes/forms/test-ids/framework), targeted excerpts.
- Structured-output contract: model returns schema-valid `FlowStep[]`; validate + reject/retry; store as `origin = ai`, `status = draft`.
- Draft ingest endpoint (run-token) + `flow-drafts` list + approve→v1 (human-authored) flow.
- SPA: "Suggested flows" review UI with source references and reasoning; edit-then-approve.

**Deliverables:** on-demand AI flow drafting, review/approve workflow, provider config.

**Acceptance**
- Point a project at a sample repo → analysis produces at least valid, editable draft flows referencing real routes/forms.
- No secret values are sent to the provider; drafts use `{{secrets.*}}` placeholders.
- A draft cannot be scheduled/run until an `editor` approves it; approval is audited with AI origin recorded.

---

## Phase 8 — Reporting depth, hardening & open-source release

**Goal:** production-ready and publishable.

**Tasks**
- Reporting: run comparison, per-flow trends, HTML report generation to R2, filters and search.
- Reliability: reconciliation cron (orphaned runs), queue retry/backoff tuning, DO timeout tuning, dead-letter handling.
- Quotas & safety: per-project max VUs, concurrent-run caps, GitHub concurrency-group config, rate-limit tuning.
- Observability: structured Worker logs, run metrics, error tracking.
- Security pass: secret handling review, run-token scope review, dependency audit, Slack/GitHub signature edge cases.
- Docs: self-host guide (Cloudflare + GitHub App + Slack app setup), quickstart, architecture (this repo), API reference, contribution guide.
- Open-source prep: finalize license, code of conduct, examples, demo project, screenshots for the README.

**Deliverables:** hardened deployment, complete docs, public release artifacts.

**Acceptance**
- A fresh operator can self-host Charlie from the docs alone (Cloudflare deploy + GitHub App + first project) and run a test end-to-end.
- Load/soak of the control plane shows no run leaks; reconciliation closes orphaned runs.
- Security review checklist complete; no plaintext secret ever leaves the server.

---

## Cross-cutting workstreams (run throughout)

- **Testing:** unit tests for flow-core and token/OIDC modules from Phase 1; an integration harness that drives a real small workflow from Phase 3 on; e2e smoke of the dashboard.
- **Migrations discipline:** every schema change is a forward migration; never edit an applied migration.
- **Audit-first:** no mutating endpoint merges without its audit call.
- **Docs-as-you-go:** update the relevant `docs/*` file in the same PR as the feature.

---

## Sequencing rationale

1. **Auth before features** (Phase 1) — everything is scoped and audited; retrofitting is painful.
2. **The handshake before breadth** (Phase 3) — the Cloudflare↔GitHub round-trip is the riskiest unknown; prove it with Playwright before adding k6, schedules, Slack, or AI.
3. **k6 reuses the handshake** (Phase 4) — only the engine differs; dispatch, callbacks, DO, and reports are already built.
4. **Triggers, then Slack, then AI** (5→6→7) — each is additive on top of a working run pipeline and independently shippable.
5. **Hardening last** (Phase 8) — once the surface is complete, make it production- and community-ready.

---

## Defaults chosen (flag if you disagree)

These were decided to keep the plan concrete; each is cheap to revisit:

- **Frontend:** Vue 3 + Vite (matches the reference project and the team's familiarity). React is a drop-in alternative if preferred.
- **License:** Apache-2.0 (patent grant; friendly for a tool others deploy). MIT if you want maximum permissiveness.
- **Runtime/tooling:** Bun for the runner CLI and local scripts; Wrangler for the Worker. npm works too.
- **Artifact retention:** R2 objects expire after 30 days by default (configurable); D1 reports kept indefinitely.
- **Run token TTL:** expires on terminal status or after 6 hours, whichever first.
- **Default AI provider:** none preconfigured; an admin must add a key before AI features unlock.

## Open questions to resolve before/at each phase

- **GitHub Actions cost ceiling** — expected concurrent runs and VU counts drive the concurrency caps in Phase 8 (and whether self-hosted runners get pulled earlier). Rough numbers would help size defaults.
- **Slack app scope** — single workspace is assumed (self-host single-org). Confirm no need for multi-workspace.
- **Recorder extension** — the reference project has a browser recorder for capturing flows. Is that in scope for v1, or is AI-drafting + manual authoring enough to start? (Currently deferred; easy to slot after Phase 7.)
- **Data residency** — any requirement to keep source code out of third-party LLMs? If so, default the AI provider to Workers AI.
- **Prod-environment guardrails** — should running load against a `prod` environment require an extra confirmation or a dedicated role? (Recommended; not yet specced.)
