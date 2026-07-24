# Charlie

**Open-source E2E and load testing for any web application.**

Charlie lets QA engineers define browser flows once and run them as **end-to-end correctness tests** (Playwright) or **load tests** (k6) against any environment of any project — on demand, on a schedule, or automatically when code merges. It reports results to a dashboard and to Slack, keeps a full audit trail of who changed what, and can draft the first version of a flow for you by reading your app's source code.

Charlie is **not** tied to any framework, cloud, or domain. If it runs in a browser and answers on a URL, Charlie can test it.

---

## Why Charlie

Most teams stitch together three things by hand: a place to store test flows, a way to run them at scale, and a way to see what happened. Charlie is that glue, opinionated and self-hostable:

- **One flow, two modes.** Author a flow once. Run it as a Playwright E2E check (does the journey work?) or feed the same intent into a k6 HTTP load scenario (does it work under N concurrent users?).
- **Bring your own Playwright code.** For journeys too complex for step-based flows, point a flow at a GitHub repo of real Playwright tests. Charlie clones it, runs `playwright test` against the chosen environment, and reports back — code flows and step flows run side by side. See [docs/CUSTOM_TESTS.md](docs/CUSTOM_TESTS.md).
- **Composable flows.** Reuse a group of steps across flows — author a `login` flow once and drop it into others as a single `useFlow` step; Charlie inlines its current steps at run time.
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
| Language / tooling | TypeScript, Bun (install/runtime), Nx (monorepo), Biome, Wrangler |

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
| [docs/CUSTOM_TESTS.md](docs/CUSTOM_TESTS.md) | Code flows: run your own Playwright tests from a GitHub repo |
| [docs/CI_INTEGRATION.md](docs/CI_INTEGRATION.md) | GitHub App, reusable workflow, dispatch, on-merge triggers, cron |
| [docs/SLACK.md](docs/SLACK.md) | Slash commands, run reporting, install flow |
| [docs/AI_FLOWGEN.md](docs/AI_FLOWGEN.md) | Source analysis, provider abstraction, flow drafting |
| [docs/API.md](docs/API.md) | REST endpoint reference |
| [EXECUTION_PLAN.md](EXECUTION_PLAN.md) | Phased, detailed build plan with acceptance criteria |

---

## Status

In development. **Phases 0–7 are complete and verified.**

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

Phase 4 — Load engine (k6):

- `@charlie/flow-core` compiles a flow into a k6 HTTP scenario (`goto`→request, `fill`→form body, `submit`→POST, `extract` regex→response capture, `waitFor(ms)`→think-time, `setHeader`→headers; clicks/DOM asserts are surfaced as "not applicable in load mode").
- Named profiles (`smoke`/`load`/`stress`) supply stage/threshold presets; a flow's `loadProfile` overrides either.
- `packages/runner` k6 engine: esbuild-bundles the k6 entrypoint with the compiled scenario baked in (k6 can't import Node at runtime), runs `k6 run`, parses the end-of-test summary, and posts a `load_summary` (p50/p95/p99, RPS, error rate, per-threshold pass/fail); thresholds decide pass/fail and name the breached metric.
- SPA: a load report view with metric cards, a latency distribution chart, and threshold pass/fail.

The **same flow definition** runs as Playwright (Phase 3) or k6 (Phase 4) with no edits.

Phase 5 — Scheduling & triggers:

- `schedules` (migration `0005`) with `runs.schedule_id` for per-schedule history; run creation is factored into one path (`createRun`) shared by manual, cron, and merge triggers.
- A Cloudflare **Cron Trigger** (once a minute) runs a sweep that selects due cron schedules, claims each with a conditional D1 update (so a tick fires exactly once even across overlapping invocations), creates a run, and advances `next_due_at`; a small UTC cron parser computes due times.
- A GitHub **webhook receiver** (`/webhooks/github`) verifies the `X-Hub-Signature-256` HMAC, then matches a `push`/merged-`pull_request` on a watched branch to `on_merge` schedules (by the project's `source_repo`), creating a run tagged with the commit and `trigger = merge`.
- SPA: per-project schedule management — cron builder with presets, branch watcher, enable/disable, next-run display, and per-schedule run history.

Phase 6 — Slack integration:

- `integrations` (migration `0006`) storing the single-workspace Slack app's bot token + signing secret AES-GCM encrypted at rest (never returned to a client); `runs.slack_channel` + a per-project default channel as report targets.
- `/slack/command`: verifies the Slack request (5-minute replay window + `v0` HMAC), **acks within 3s**, then does the work asynchronously — maps the Slack user to a Charlie user by verified email, gates on the same `runs.trigger` capability as the web app (refusing + auditing otherwise), and creates a `trigger = slack` run — replying via `response_url`. `/slack/interactivity` handles the **Re-run** button.
- Command grammar `run`/`e2e`/`load`/`status`/`last`/`help`.
- Post-run reporter: the Run Coordinator posts a Block Kit pass/fail message (flows passed, or load percentiles + breached threshold) with **View report** and **Re-run** buttons to the originating channel, and scheduled/merge runs report to the project's default channel.
- SPA: an Integrations settings page (connect/disconnect Slack) and a per-project default report channel.

Phase 7 — AI-assisted flow generation:

- `ai_providers` (migration `0007`, bring-your-own-key encrypted at rest) with a per-org default; `flow_drafts` and `ai_analyses` track AI output and analysis jobs.
- Analysis runs on GitHub Actions (heavy work off the Worker): an `ai-analyze` workflow checks out the project's `source_repo` read-only, a static pass extracts routes/forms/test-ids/framework, and the configured provider (Anthropic / OpenAI / Workers AI, behind an `AiProvider` interface) returns drafts under a **structured-output contract** — validated against the flow schema and rejected/retried if malformed, never executed blind.
- Drafts POST back (analysis-token auth) and store as `origin = ai`, `status = draft`. **No environment secrets are ever sent** to the provider; drafts use `{{secrets.*}}` placeholders.
- A draft is not runnable until an `editor` **approves** it, which mints a real flow + human-authored v1 (the AI is credited in `origin`); approval is audited.
- SPA: AI provider settings, an "Analyze source repo" action, and a Suggested-flows review UI with the model's reasoning and source references, plus approve/reject.

**Composable flows (`useFlow`):**

- A step flow can include another steps flow via a `useFlow` step (e.g. a shared `login` group run first). The control plane inlines the referenced flow's **current** steps into the run bundle recursively — with same-project, no-code-reference, and cycle guards — so engines still receive a flat step list and extracted vars/headers carry forward. See [docs/TEST_ENGINES.md](docs/TEST_ENGINES.md#composing-flows-useflow).

**Custom Playwright code flows:**

- A flow can be a **`code`** flow — a pointer (`flow_versions.code_spec`) to a GitHub repo of real Playwright tests — alongside the existing `steps` flows (`flows.kind`, migration `0003`).
- On a run, the runner clones the repo (with a short-lived, run-scoped GitHub App clone token minted into the bundle), installs its dependencies (package manager auto-detected from the lockfile), and runs `playwright test`, injecting the environment as `CHARLIE_BASE_URL` / `CHARLIE_HEADERS` / `CHARLIE_SECRET_*`. Pass/fail comes from Playwright's JSON report; the report and traces upload to R2 via the same shard-result pipeline as step flows.
- A worked template ships in [`examples/playwright-custom-tests`](examples/playwright-custom-tests); the contract is documented in [docs/CUSTOM_TESTS.md](docs/CUSTOM_TESTS.md). A [`charlie-playwright` Claude Code skill](skills/charlie-playwright) (`npx skills add justraman/charlie --skill charlie-playwright`, also surfaced in the flow-creation UI) teaches the model the env contract so AI-written tests run here unchanged.

See [EXECUTION_PLAN.md](EXECUTION_PLAN.md) for what's next (Phase 8: reporting depth, hardening & open-source release).

## Local development

Requires [Bun](https://bun.sh); the Wrangler CLI and [Nx](https://nx.dev) come in as dev dependencies. Charlie is an **Nx-managed monorepo** (`apps/web`, `packages/flow-core`, `packages/runner`): a **single root `package.json`** holds all dependencies, each project is defined by a `project.json`, and Nx runs/caches `typecheck`/`test`/`build` per project (`nx affected` scopes to what changed). Bun is the installer and runtime (no workspaces); the one cross-package import, `@charlie/flow-core`, resolves from source via TypeScript path mappings (for `tsc` and Bun) plus a wrangler/esbuild alias (for the Worker bundle). Biome is the linter/formatter, run repo-wide.

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
bun run typecheck   # nx run-many -t typecheck (cached, all projects)
bun run test        # nx run-many -t test (cached)
bun run build       # nx run @charlie/web:build
bun run affected    # only what changed vs main
bun run graph       # interactive project graph
bun run lint        # Biome (repo-wide)

# Run a single project's target directly:
bunx nx run @charlie/flow-core:test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
