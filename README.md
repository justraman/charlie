# Charlie

**Open-source E2E and load testing for any web application.**

Charlie lets QA engineers define browser flows once and run them as **end-to-end correctness tests** (Playwright) or **load tests** (k6) against any environment of any project — on demand, on a schedule, or automatically when code merges. It reports results to a dashboard and to Slack, keeps a full audit trail of who changed what, and can draft the first version of a flow for you by reading your app's source code.

Charlie is **not** tied to any framework, cloud, or domain. If it runs in a browser and answers on a URL, Charlie can test it.

---

## Why Charlie

Most teams stitch together three things by hand: a place to store test flows, a way to run them at scale, and a way to see what happened. Charlie is that glue, opinionated and self-hostable:

- **One flow, two modes.** Author a flow once. Run it as a Playwright E2E check (does the journey work?) or feed the same intent into a k6 HTTP load scenario (does it work under N concurrent users?).
- **Any project, any environment.** Register multiple projects; each has environments (`dev`, `qa`, `staging`, `prod`, or whatever you name) with their own base URL, headers, and secrets. Point a run at exactly one.
- **Runs where and when you want.** Trigger manually from the dashboard, from Slack, on a cron interval, or automatically on a merge to a watched branch.
- **Slack-native.** `/charlie run checkout --env qa` kicks off a run; results post back to the channel when they finish.
- **AI-assisted authoring.** Connect a source repo and Charlie drafts candidate flows by reading routes, forms, and components — you review and refine instead of starting from a blank page.
- **Accountable by default.** Google SSO for login; every mutating action (flow edit, schedule change, run trigger, member change) is written to an immutable audit log.

---

## Architecture at a glance

Charlie splits cleanly into a **control plane** on Cloudflare and a **compute plane** on GitHub Actions.

```
            ┌──────────────────────── Cloudflare ────────────────────────┐
   Browser  │  Worker (Hono)      D1 (SQLite)     Durable Objects         │
   Slack ──▶│  · SPA + REST API   · projects      · per-run coordinator   │
   GitHub ─▶│  · Google SSO       · flows/runs    · live progress fan-out │
   webhooks │  · audit log        · audit_log     Queues · Cron · R2      │
            └───────────────┬──────────────────────────────┬─────────────┘
                            │ workflow_dispatch             │ vu-result / artifacts
                            ▼                               ▲
            ┌──────────────────────── GitHub Actions ───────┴─────────────┐
            │  Reusable workflow · matrix fan-out                         │
            │  Playwright (E2E)   k6 (HTTP load)   AI repo analysis job   │
            └─────────────────────────────────────────────────────────────┘
```

- **Cloudflare** holds all state and does none of the heavy lifting. The Worker serves the dashboard and API, authenticates users, coordinates runs, and stores reports. D1 is the system of record; R2 holds large artifacts (screenshots, videos, traces, HTML reports); Durable Objects coordinate each live run; Queues decouple dispatch; Cron Triggers fire scheduled runs.
- **GitHub Actions** runs the actual browsers and load generators. Charlie dispatches a reusable workflow; each virtual user or shard reports back to the Worker API and uploads artifacts to R2.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

---

## Tech stack

| Layer | Choice |
|---|---|
| Control plane | Cloudflare Workers (Hono), Durable Objects, Queues, Cron Triggers |
| Database | Cloudflare D1 (SQLite) |
| Artifact storage | Cloudflare R2 |
| Frontend | React + Vite SPA, served by the Worker |
| Compute | GitHub Actions (GitHub-hosted runners) |
| E2E engine | Playwright |
| Load engine | k6 (protocol-level HTTP) |
| Auth | Google SSO (OIDC) |
| AI | Pluggable provider (Anthropic Claude / OpenAI / Cloudflare Workers AI) |
| Integrations | Slack app, GitHub App |
| Language / tooling | TypeScript, Bun or npm, Biome, Wrangler |

---

## Key decisions (self-host, single org)

Charlie ships as a **self-hosted, single-organization** tool: you deploy it to your own Cloudflare account, restrict Google SSO to your allowed email domains, and manage many projects inside that one organization. The data model reserves room to grow into multi-org later, but the v1 product is one org, many projects.

Other confirmed decisions:

- **GitHub-hosted runners** for the first release (self-hosted runner support is a later, additive feature).
- **k6 for load, Playwright for E2E** — a single flow definition compiles to either.
- **Pluggable AI provider** — bring your own key; Claude, OpenAI, and Workers AI are the initial adapters.

---

## Documentation

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, run lifecycle, data flow, topology |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | D1 schema, entities, relationships, audit log |
| [docs/AUTH.md](docs/AUTH.md) | Google SSO, sessions, RBAC, audit trail, API keys |
| [docs/TEST_ENGINES.md](docs/TEST_ENGINES.md) | Flow format, Playwright + k6 execution, engine abstraction |
| [docs/CI_INTEGRATION.md](docs/CI_INTEGRATION.md) | GitHub App, reusable workflow, dispatch, on-merge triggers, cron |
| [docs/SLACK.md](docs/SLACK.md) | Slash commands, run reporting, install flow |
| [docs/AI_FLOWGEN.md](docs/AI_FLOWGEN.md) | Source analysis, provider abstraction, flow drafting |
| [docs/API.md](docs/API.md) | REST endpoint reference |
| [EXECUTION_PLAN.md](EXECUTION_PLAN.md) | Phased, detailed build plan with acceptance criteria |

---

## Status

In development. **Phases 0–2 are complete and verified.**

Phase 1 — Auth, RBAC & audit:

- Cloudflare Worker (Hono) serving the React SPA and a `/api` surface, D1 as the system of record.
- Google OIDC login with PKCE + `state`, ID-token verification, and a domain gate; first user becomes `owner`.
- Session cookies (hash stored in D1), the single authenticate → authorize → rate-limit middleware, and the role→capability RBAC matrix.
- Machine auth via scoped, hashed API keys.
- An append-only audit log written in the same D1 transaction as every mutation, with secret redaction.
- Members and API-key management (UI + API).

Phase 2 — Projects, environments & flow authoring:

- Projects, environments, flows, and immutable `flow_versions` (migration `0003`).
- CRUD APIs for all three, every mutation audited; environment secrets AES-GCM encrypted at rest and returned only masked.
- `@charlie/flow-core`: the Zod `FlowStep` schema, `{{secrets.*}}`/`{{vars.*}}` placeholder resolution, the engine-agnostic step executor + `actionRegistry`, and version diffing.
- SPA: project list/detail, environment editor with masked secrets, a step-based flow editor (add/edit/reorder), and flow version history with per-version diffs.

Phase 3 — Execution plane (the control/compute handshake):

- Runs, shards, results, and reports (migration `0004`); a Cloudflare **Queue** decouples dispatch, a **Durable Object** (Run Coordinator) tracks shard check-ins, aggregates results, fans out live progress over **SSE**, enforces a dead-shard timeout, and writes the terminal report; **R2** holds artifacts.
- `POST /api/runs` → queued run + Coordinator init + enqueue; queue consumer mints a run token and dispatches the GitHub reusable workflow, resolving `gha_run_id`.
- Machine-callback routes authorized by short-lived, run-scoped tokens: flow bundle (with decrypted secrets), shard-result, artifact upload, finalize. Cancel + GitHub App token/dispatch/resolve/cancel modules.
- `packages/runner`: a CLI (`fetch-flow`/`execute`/`finalize`) with a Playwright engine implementing the flow-core adapter, plus the `charlie-run.yml` reusable workflow.
- SPA: trigger runs, run list, and a run detail page with live SSE progress and an artifact viewer.

See [EXECUTION_PLAN.md](EXECUTION_PLAN.md) for what's next (Phase 4: the k6 load engine).

## Local development

Requires [Bun](https://bun.sh) and the Cloudflare Wrangler CLI (installed as a dev dependency).

```bash
bun install

# Apply migrations to a local D1 database
bun run db:migrate:local

# Configure secrets for local dev
cp .dev.vars.example apps/web/.dev.vars   # then fill in Google OIDC client id/secret + CHARLIE_KEK

# Run the Worker (SPA + API + local D1) on http://localhost:8787
bun run --cwd apps/web dev:worker

# Or run the Vite HMR dev server (proxies /api to the Worker) alongside it
bun run dev
```

Set `ALLOWED_EMAIL_DOMAINS` in `apps/web/wrangler.toml` (or via `--var`) so the first Google login can bootstrap the organization. Useful checks:

```bash
bun test          # unit suite (OIDC verification, crypto, RBAC, audit redaction)
bun run typecheck # worker + SPA
bun run lint      # Biome
```

## License

Apache-2.0. See [LICENSE](LICENSE).
