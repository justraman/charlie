# Self-Hosting Charlie

Charlie is one Cloudflare Worker (the control plane) plus GitHub Actions (the compute plane). The Worker serves the React SPA, the API, the Run Coordinator Durable Object, the Queue consumer, and the Cron sweep; every test actually runs on GitHub Actions. This guide takes a fresh operator from zero to a deployed instance running its first test.

Charlie is **self-hosted, single-organization**: you deploy it to your own Cloudflare account and gate Google SSO to your email domains. That allow-list is the tenancy boundary.

## Prerequisites

- **Cloudflare account on the Workers paid plan.** Durable Objects and Queues are not available on the free plan.
- **`bun` 1.3.13** and **`wrangler`** (authenticate once with `wrangler login`).
- **A GitHub repository for the runner.** For v1 the runner repo *is* the Charlie repo — it already ships `.github/workflows/charlie-run.yml`. You point `GITHUB_RUNNER_REPO` at wherever you host this code.
- **A Google Cloud project** for OIDC (an OAuth 2.0 Web client).
- **A GitHub App** for workflow dispatch, on-merge webhooks, and AI source reads.
- *(Optional, post-deploy)* a Slack app and/or an AI provider key — both are configured through the UI after the instance is up, not at deploy time.

## 1. Create the Cloudflare resources

Run these once, then paste the returned ids into `apps/web/wrangler.toml` (the committed file ships placeholders):

```bash
wrangler d1 create charlie-db            # → copy database_id  → [[d1_databases]] database_id
wrangler kv namespace create charlie-kv  # → copy id           → [[kv_namespaces]] id
wrangler r2 bucket create charlie-artifacts
wrangler queues create charlie-runs
```

The R2 bucket, Queue, and Durable Object are referenced by name, so only the **D1 `database_id`** and the **KV `id`** need to be pasted in. Until you do, a remote deploy fails — the shipped values (`00000000-…` and `charlie_kv_local_placeholder`) are local-dev stand-ins only.

## 2. Google OIDC

Create an **OAuth 2.0 Web client** in the Google Cloud Console and set its authorized redirect URI to your instance:

```
https://<your-domain>/api/auth/google/callback
````

Keep the **Client ID** and **Client secret** for step 4. See [AUTH.md](AUTH.md) for the full login flow and session model.

## 3. GitHub App

Create **one** GitHub App (not a personal token) and install it on both the runner repo and any source repos you want to watch. The App does three jobs: dispatches the reusable workflow, receives `push`/`pull_request` webhooks for on-merge triggers, and reads source (read-only) for AI flow generation. See [CI_INTEGRATION.md](CI_INTEGRATION.md) for how it's used.

### 3.1 Register the App

Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** (or your **org → Settings → Developer settings → GitHub Apps** if the runner repo lives in an org), and fill in:

| Field | Value |
| --- | --- |
| **GitHub App name** | globally unique, e.g. `charlie-<yourco>` |
| **Homepage URL** | `https://<your-domain>` |
| **Webhook → Active** | checked |
| **Webhook URL** | `https://<your-domain>/webhooks/github` |
| **Webhook secret** | generate one (`openssl rand -hex 32`) and save it |

If you haven't deployed yet and have no domain, use a placeholder URL and edit it after deploy — the webhook is only needed for on-merge triggers.

### 3.2 Permissions & events

Under **Repository permissions** set exactly (least privilege):

- **Actions:** Read and write — dispatch + cancel workflow runs
- **Contents:** Read-only — checkout runner code + AI source read
- **Metadata:** Read-only — mandatory, auto-selected

Under **Subscribe to events** check **Push** and **Pull request**.

### 3.3 Collect credentials & install

1. **App ID** — shown at the top of the App page → `GITHUB_APP_ID`.
2. **Generate a private key** (bottom of the page) → downloads a `.pem` → `GITHUB_APP_PRIVATE_KEY` (but convert it first, see 3.4).
3. **Install App** (left sidebar) on your **runner repo** (for v1 that's the Charlie repo itself, which ships `charlie-run.yml`) and any **source repos** you want on-merge triggers / AI generation for.
4. After installing, the browser URL is `.../installations/<number>` — that number is `GITHUB_INSTALLATION_ID`.

### 3.4 Convert the private key to PKCS#8

GitHub issues a **PKCS#1** key (`-----BEGIN RSA PRIVATE KEY-----`), but the Worker imports it with `jose`'s `importPKCS8()` (`worker/lib/github.ts`), which requires **PKCS#8** (`-----BEGIN PRIVATE KEY-----`). Convert before setting the secret:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in your-app.<date>.private-key.pem \
  -out charlie-gh-key-pkcs8.pem
```

Use the `charlie-gh-key-pkcs8.pem` output as `GITHUB_APP_PRIVATE_KEY` in step 4.

### 3.5 Verify (after deploy)

`GET https://<your-domain>/api/integrations` returns `github: { configured, connected, detail }`. `connected: true` means the App id, key, and installation successfully minted an installation token; `detail` shows the runner repo. If `connected: false`, `detail` carries the truncated GitHub error — the usual cause is a key still in PKCS#1 (redo 3.4) or a wrong installation ID.

## 4. Set Worker secrets

Secrets are set with `wrangler secret put` (never committed). Run from `apps/web/`. The full list — with generation hints — lives in [`.dev.vars.example`](../.dev.vars.example); locally the same values go in `apps/web/.dev.vars` (gitignored).

```bash
cd apps/web

# Encryption + tokens
wrangler secret put CHARLIE_KEK                # 32-byte base64: openssl rand -base64 32
wrangler secret put CHARLIE_RUN_TOKEN_SECRET   # openssl rand -base64 32 (falls back to KEK if unset)

# Google OIDC
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# GitHub App (dispatch / webhooks / AI source read)
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY     # PKCS#8 PEM — preserve newlines
wrangler secret put GITHUB_INSTALLATION_ID
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_RUNNER_REPO         # e.g. your-org/charlie
```

Optional secrets:

- `GITHUB_RUNNER_REF` (default `main`) and `RUNNER_WORKFLOW_FILE` (default `charlie-run.yml`) — only if your runner repo differs from the defaults.
- `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` — enable **presigned** artifact uploads directly to R2. Absent, the Worker proxies uploads through the R2 binding, which works but funnels artifact bytes through the Worker.

> **Slack and AI providers are not env secrets.** Slack's signing secret and bot token are stored encrypted in the `integrations` table via the Integrations page; AI provider keys are stored encrypted in `ai_providers` via AI Settings. Both are configured after deploy (see step 8).

## 5. Set non-secret vars

Edit the `[vars]` block in `apps/web/wrangler.toml`:

```toml
[vars]
APP_BASE_URL = "https://<your-domain>"   # public origin; used for OIDC redirect + links
COOKIE_SECURE = "true"                    # required over HTTPS
ORG_NAME = "Your Company"
ALLOWED_EMAIL_DOMAINS = "yourco.com"      # comma-separated SSO allow-list
```

`ALLOWED_EMAIL_DOMAINS` **must** be set before first login — it gates who can sign in, and the first user from an allowed domain becomes the `owner`. After first login the org row exists and the domain list is edited in the DB/admin UI.

## 6. Custom domain

`wrangler.toml` ships with `workers_dev = true`, giving you a `<name>.workers.dev` URL out of the box. To serve on your own domain, the domain must be a **zone on your Cloudflare account** (DNS managed by Cloudflare). Add a route:

```toml
[[routes]]
pattern = "charlie.yourco.com"
custom_domain = true   # Cloudflare creates + manages the DNS record and TLS cert
```

`wrangler deploy` then provisions the domain, DNS record, and certificate automatically (allow a minute for it to go live). Set `workers_dev = false` once the custom domain is live if you don't want the `.workers.dev` URL exposed.

Make sure the three external callback URLs point at the same origin as `APP_BASE_URL`:

| Service | URL |
| --- | --- |
| Google OAuth redirect | `https://<domain>/api/auth/google/callback` |
| GitHub App webhook | `https://<domain>/webhooks/github` |
| Slack (if used) | `https://<domain>/slack/command` and `/slack/interactivity` |

## 7. Migrate and deploy

Apply the schema to the remote D1, then deploy. Run migrations **before** the first deploy — the Worker assumes all tables exist on boot.

```bash
# from apps/web (or repo root, which proxies these)
bun run db:migrate:remote     # wrangler d1 migrations apply charlie-db --remote
bun run deploy                # vite build && wrangler deploy
```

`bun run deploy` builds the SPA into `dist/client` (served as static assets) and pushes the Worker. Confirm the binding table wrangler prints matches your resources. You can rehearse the build + binding resolution without pushing via `bun run deploy:dry`.

## 8. First run

1. Visit your instance and **sign in with Google**. The first user from an allowed domain becomes `owner`; the org row is seeded from `ORG_NAME` / `ALLOWED_EMAIL_DOMAINS`. Later users default to `viewer` and are promoted from the Members page.
2. **Create a project.** Set `source_repo` (`owner/repo`) if you want on-merge triggers or AI flow generation.
3. **Add an environment** (base URL + any secrets — secrets are AES-GCM encrypted and never returned in API responses).
4. **Author a flow** in the editor, or use **AI Settings → Suggested Flows** to draft one from source and approve it.
5. **Trigger a run.** It dispatches `charlie-run.yml`, shards report back, and the run reaches `passed`/`failed` with artifacts and a live progress stream.
6. *(Optional)* Connect **Slack** on the Integrations page and add an **AI provider** in AI Settings.

## Verifying the deployment

- `GET https://<domain>/api/health` returns `200`.
- A user from an allowed domain logs in; a disallowed domain is rejected (and the rejection is audited).
- A triggered run dispatches a workflow in the runner repo and reaches a terminal state with a report.
- Killing a shard mid-run still closes the run (the Run Coordinator's dead-shard timeout fires).

## Notes & gotchas

- **Local dev origin is `wrangler dev` on `:8787`** (serves SPA + API + local D1). `bun run dev` runs the Worker and Vite together; the Vite `:5173` server is HMR-only and proxies `/api` to the Worker. Apply local migrations with `bun run db:migrate:local`.
- **D1 CLI uses the database name `charlie-db`** (or binding `DB`), not `charlie`.
- **`CHARLIE_KEK` is load-bearing and unrecoverable.** It encrypts environment secrets, integration credentials, and AI keys at rest. Back it up; rotating it requires re-encrypting stored ciphertext.
- **Cost.** Each run consumes GitHub Actions minutes on your account; the Cron Trigger runs once a minute to sweep due schedules. Per-project VU and concurrency caps are part of Phase 8 hardening and not yet enforced.

## Related docs

- [ARCHITECTURE.md](../ARCHITECTURE.md) — the control/compute split and request lifecycle.
- [AUTH.md](AUTH.md) — SSO, sessions, RBAC, audit, run tokens.
- [CI_INTEGRATION.md](CI_INTEGRATION.md) — GitHub App, reusable workflow, dispatch, triggers.
- [SLACK.md](SLACK.md) — connecting the Slack app and slash commands.
- [AI_FLOWGEN.md](AI_FLOWGEN.md) — AI providers and the analyze → draft → approve flow.
