# Custom Playwright tests (code flows)

Charlie's step-based flows (see [TEST_ENGINES.md](TEST_ENGINES.md)) are great for
straightforward journeys, but some tests are simply easier to express as real
Playwright code — complex assertions, fixtures, page objects, conditional logic.
For those, a flow can be a **`code` flow**: a pointer to a GitHub repo containing
a Playwright project. Charlie checks the repo out on the compute plane, runs
`playwright test`, and reports results through the same pipeline as everything
else. Code flows and step flows live side by side in a project and can run in the
same run.

A ready-to-copy template lives in
[`examples/playwright-custom-tests`](../examples/playwright-custom-tests).

## Write tests with AI (the `charlie-playwright` skill)

Charlie ships a [Claude Code skill](../skills/charlie-playwright) that teaches
the model this contract — the env vars, secret handling, grep tagging, and the
import steps — so the Playwright it writes runs here unchanged. Install it into
your own test repo (it's surfaced in the UI on the **Custom Playwright code**
flow form too):

```bash
npx skills add justraman/charlie --skill charlie-playwright
```

Then ask Claude to "write a Charlie-compatible Playwright test" in that repo.

## The two flow kinds

| | `steps` flow | `code` flow |
|---|---|---|
| Authored as | JSON steps (dashboard editor, or an uploaded flow document) | Playwright `*.spec.ts` in a repo |
| Engines | Playwright **and** k6 (one definition, two modes) | Playwright only |
| Stored in | `flow_versions.steps` | `flow_versions.code_spec` |
| Runs by | flow-core step executor | cloning the repo + `playwright test` |

A flow's kind is chosen at creation and fixed thereafter. Every version of a code
flow is a new `code_spec` snapshot (repo/ref/filter), diffed in the history view
just like step versions.

## The code spec

A code flow stores a small pointer, validated at the API boundary
(`codeSpecSchema` in `@charlie/flow-core`):

```jsonc
{
  "repo": "acme/web-e2e-tests",   // required — GitHub "owner/repo"
  "ref": "main",                   // optional — branch/tag/SHA (default branch if omitted)
  "workingDir": "packages/e2e",    // optional — where package.json lives (repo root if omitted)
  "testFilter": "tests/checkout.spec.ts", // optional — positional `playwright test` arg
  "grep": "@smoke",                // optional — `playwright test --grep`
  "installCommand": "...",         // optional — override the auto-detected install
  "testCommand": "..."             // optional — replace the whole test command (advanced)
}
```

`testFilter` and `grep` map straight onto `playwright test`, so one repo can back
several code flows that each select a different slice of the suite.

## The environment contract

Charlie passes the selected environment into the test process as **plain env
vars** — there is no Charlie SDK to install:

| Variable | Meaning |
|---|---|
| `CHARLIE_BASE_URL` | The environment's `base_url`. Point Playwright's `baseURL` at it so relative `page.goto()` calls resolve. |
| `CHARLIE_HEADERS` | JSON of the environment's default headers; forward via `extraHTTPHeaders`. |
| `<NAME>` | **Each environment secret, under its own name** — secret `TEST_EMAIL` arrives as `process.env.TEST_EMAIL`. Charlie does not rename it, so a repo that already reads its own env vars runs here unchanged. |
| `CHARLIE_SECRET_<NAME>` | The same secret, prefixed. Always set; it's how you reach a secret whose own name is reserved (below). |
| `PLAYWRIGHT_BASE_URL` | Same value as `CHARLIE_BASE_URL`, for configs that already read this. |

### Reserved secret names

A secret is exported under its own name unless that name would take over a
variable Charlie sets or one the run depends on. These are exported **only** in
the `CHARLIE_SECRET_<NAME>` form:

`CHARLIE_BASE_URL`, `CHARLIE_HEADERS`, `CHARLIE_RUN_TOKEN`, `CHARLIE_REPORT_NAME`,
`PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_JSON_OUTPUT_NAME`, `PATH`, `HOME`, `PWD`,
`SHELL`, `TMPDIR`, `CI`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`

The same applies to a name that isn't a legal env var name (must match
`[A-Za-z_][A-Za-z0-9_]*`). Either way the run's `log.txt` names the secrets it
skipped — never their values — so a missing variable is self-explaining rather
than a mystery failure.

A minimal `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  use: {
    baseURL: process.env.CHARLIE_BASE_URL,
    extraHTTPHeaders: JSON.parse(process.env.CHARLIE_HEADERS || '{}'),
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
```

And a secret is read like any other env var:

```ts
await page.getByLabel(/email/i).fill(process.env.TEST_EMAIL!)
```

**Secrets are never sent to any third party.** They are decrypted only on the
compute-plane runner (the same boundary crossing as step-flow secrets) and exist
solely as env vars inside the test process for the duration of the run.

## How a run executes a code flow

1. **Bundle.** The runner fetches the run bundle. For code flows the bundle
   includes each flow's `code` spec and — when the GitHub App is configured — a
   short-lived, installation-scoped **clone token**.
2. **Checkout.** The runner clones `repo` (at `ref`) using the token
   (`https://x-access-token:<token>@github.com/owner/repo`). Clones are cached
   per repo+ref across a shard's flows. The token embeds in the clone URL and is
   never logged.
3. **Install.** In `workingDir`, dependencies are installed with the package
   manager detected from the lockfile (`bun` → `pnpm` → `yarn` → `npm ci` →
   `npm install`), or `installCommand` if set. The matching browser is fetched
   with `playwright install chromium`.
4. **Test.** Charlie runs `playwright test --reporter=list,json` (plus
   `testFilter` / `--grep`), with the environment contract above in the process
   env. `testCommand` overrides the whole command if you need something bespoke.
5. **Report.** Charlie reads Playwright's JSON report: the flow **passes** when
   `stats.unexpected === 0` and there are no top-level errors. It uploads
   `playwright-report.json`, a `log.txt`, and any Playwright traces
   (`test-results/**/*.zip`) to R2, which the run detail page links.

Sharding treats each code flow like any other flow (round-robin across shards).
Because code flows have no HTTP compilation, they do **not** run under k6 — a k6
run silently selects only k6-capable step flows.

## Requirements & tips

- **Install the Charlie GitHub App on the test repo** so the control plane can
  mint a clone token for it (the same App used for on-merge triggers).
  A public repo clones without a token.
- **Commit a lockfile** for reproducible, faster installs.
- **Tag tests** (`@smoke`, `@login`, …) so a code flow's `grep` can target them.
- Keep the repo's own `playwright.config.ts` reporters for local runs — Charlie
  overrides the reporter on the CLI only for the run it drives.

See the [example repo](../examples/playwright-custom-tests) for a working setup.
