# Importing your tests into Charlie

Once the repo runs locally against the contract, turn it into a Charlie **code
flow**.

## 1. Install the Charlie GitHub App on the repo

Charlie clones the repo with a short-lived, run-scoped token minted by its
GitHub App (the same App used for on-merge triggers and AI analysis). Install it
on the repo (or org) that holds your tests. A **public** repo clones without a
token, but private repos require the App.

## 2. Create the flow

In Charlie: open a project → **New flow** → **Flow type: Custom Playwright
code**, then fill in:

| Field | Required | What it is |
|---|---|---|
| **Repository** | yes | `owner/repo` (e.g. `acme/web-e2e-tests`). |
| **Git ref** | no | Branch, tag, or SHA. Defaults to the repo's default branch. |
| **Working directory** | no | Where `package.json` lives, if not the repo root (e.g. `packages/e2e`). |
| **Test filter** | no | Positional `playwright test` arg — a spec file, directory, or pattern (e.g. `tests/checkout.spec.ts`). |
| **Grep** | no | `playwright test --grep` value — a title filter (e.g. `@smoke`). |

Trigger a run against an environment. Charlie clones the repo, installs
dependencies (package manager auto-detected from the lockfile:
`bun` → `pnpm` → `yarn` → `npm`), fetches the browser
(`playwright install chromium`), runs the tests with the environment contract in
the process env, and shows the result plus uploaded traces in the run report.

## 3. Tag tests so one repo backs many flows

`testFilter` and `grep` map straight onto `playwright test`, so you can slice one
suite into several flows without duplicating code:

- Tag titles: `test('checkout works @smoke @checkout', ...)`.
- A `@smoke` flow → **Grep** = `@smoke`.
- A checkout-only flow → **Test filter** = `tests/checkout.spec.ts`.
- A full-suite flow → leave both blank.

Prefer grep tags over path filters when a logical group spans multiple files.

## Requirements & tips

- **Commit a lockfile** (`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, or
  `package-lock.json`) for reproducible, faster installs. Without one Charlie
  falls back to `npm install`.
- **Keep your own reporters** in `playwright.config.ts` for local runs — Charlie
  only overrides the reporter on the CLI for the run it drives.
- **Every flow version is a new `code_spec` snapshot** (repo/ref/filter), diffed
  in the flow's history view just like step flows.
- **Code flows are Playwright-only.** They have no HTTP compilation, so a k6
  (load) run silently skips them and selects only k6-capable step flows. If you
  need load testing, express the journey as a step flow instead.
- **Sharding** treats each code flow like any other flow (round-robin across
  shards) — no special setup needed.

## When a run fails but local passes — checklist

1. **Wrong host?** Confirm the flow's environment `base_url` is what you expect,
   and that tests navigate with **relative** paths (so `baseURL` applies).
2. **Missing header?** The environment's default headers arrive as
   `CHARLIE_HEADERS`; make sure the config forwards them via `extraHTTPHeaders`.
3. **Missing secret?** The `secret()` helper throws by name — the log names the
   missing `CHARLIE_SECRET_<NAME>`. Add it to the environment in Charlie.
4. **Committed `test.only`?** `forbidOnly` on CI fails the run. Remove it.
5. **Open the trace.** Charlie uploads `retain-on-failure` traces to the run's
   artifacts; open them in the Playwright trace viewer to see the exact step.
