# Charlie custom Playwright tests — example

This is a **plain Playwright project** wired to run inside [Charlie](../../README.md)
as a **`code` flow**. Charlie checks out the repo, runs `playwright test` against
the environment you pick, and reports pass/fail + traces back to the dashboard —
so you can keep complex journeys as real Playwright code instead of Charlie's
step-based flows.

Use this as a template: copy it into its own GitHub repo (or a subfolder of an
existing one), install the Charlie GitHub App on it, and import it in Charlie.

## Layout

```
playwright.config.ts   # reads CHARLIE_BASE_URL / CHARLIE_HEADERS
tests/
  charlie.ts           # secret() helper for CHARLIE_SECRET_* vars
  homepage.spec.ts     # baseURL-relative navigation, tagged @smoke
  login.spec.ts        # uses environment secrets, tagged @login
```

## The contract

Charlie injects the selected environment into the test process as env vars.
Nothing here is a special Charlie SDK — it's ordinary `process.env`:

| Variable | What it is |
|---|---|
| `CHARLIE_BASE_URL` | The environment's base URL. Set as Playwright's `baseURL`, so `page.goto('/cart')` hits the right host. |
| `CHARLIE_HEADERS` | JSON of the environment's default headers (auth, feature flags). Forwarded via `extraHTTPHeaders`. |
| `CHARLIE_SECRET_<NAME>` | One variable per environment secret. Read with `secret('NAME')` from `tests/charlie.ts`. Secrets are decrypted only on the compute plane and never sent to any third party. |

`playwright.config.ts` shows how to consume them. When these are unset (running
locally), it falls back to `http://localhost:3000` so the repo still works on its own.

## Run it locally

```bash
npm install
npx playwright install chromium

# Point at any environment and provide any secrets your tests read:
CHARLIE_BASE_URL=https://staging.example.com \
CHARLIE_SECRET_TEST_EMAIL=qa@example.com \
CHARLIE_SECRET_TEST_PASSWORD=hunter2 \
  npm test
```

## Import it into Charlie

1. Install the **Charlie GitHub App** on the repo (so Charlie can clone it).
2. In Charlie: open a project → **New flow** → **Flow type: Custom Playwright code**.
3. Fill in:
   - **Repository** — `owner/repo`
   - **Git ref** *(optional)* — branch/tag/SHA (defaults to the default branch)
   - **Working directory** *(optional)* — where `package.json` lives, if not the repo root
   - **Test filter** *(optional)* — a spec/dir/pattern, e.g. `tests/homepage.spec.ts`
   - **Grep** *(optional)* — a title filter, e.g. `@smoke`
4. Trigger a run against an environment. Charlie clones the repo, installs
   dependencies (detected from your lockfile), runs `playwright test`, and shows
   the result + uploaded traces in the run report.

### Selecting a subset

The **test filter** and **grep** map straight to `playwright test`:

- Filter `tests/checkout.spec.ts` → runs just that file.
- Grep `@smoke` → runs only tests whose title contains `@smoke`.

So one repo can back several Charlie code flows (a `@smoke` flow, a full-suite
flow, a per-area flow), each selecting different tests.

## Notes

- Charlie runs `playwright test --reporter=list,json` and reads the JSON report
  to decide pass/fail; keep your own reporters in `playwright.config.ts` for local runs.
- Dependency install is auto-detected from the lockfile (`bun` / `pnpm` / `yarn`
  / `npm`). Commit a lockfile for reproducible installs.
- The browser is installed at run time (`playwright install chromium`), so your
  `@playwright/test` version doesn't need to match Charlie's.
