---
name: charlie-playwright
description: >-
  Write and structure Playwright end-to-end tests that run as a Charlie "code"
  flow. Use when a QA engineer wants to author custom Playwright code (instead of
  Charlie's step-based flows), point a Charlie flow at a GitHub repo of Playwright
  tests, wire tests to Charlie environments/secrets, tag tests for grep selection,
  or debug why a code flow passes locally but not in Charlie. Triggers on:
  "Charlie Playwright test", "custom Playwright code flow", "CHARLIE_BASE_URL",
  "CHARLIE_SECRET", "import my tests into Charlie", "code flow".
---

# Charlie-compatible Playwright tests

Charlie runs custom Playwright tests as a **`code` flow**: you keep a normal
Playwright project in a GitHub repo, and Charlie checks it out, runs
`playwright test` against a selected environment, and reports pass/fail plus
traces back to its dashboard. There is **no Charlie SDK to install** — the whole
integration is a handful of environment variables Charlie sets on the test
process.

This skill helps you author tests that are correct Playwright *and* correct for
that contract, then import them into Charlie.

## The one thing that makes a test "Charlie-compatible"

Read the environment from `process.env`, never hardcode a host, a credential, or
a header. Charlie injects the target environment at run time:

| Variable | Use it as |
|---|---|
| `CHARLIE_BASE_URL` | Playwright's `baseURL` — so `page.goto('/cart')` resolves against whatever env (dev/qa/staging/prod) the run targets. `PLAYWRIGHT_BASE_URL` is set to the same value. |
| `CHARLIE_HEADERS` | JSON of the environment's default headers (auth, feature flags). Parse and pass to `extraHTTPHeaders`. |
| `CHARLIE_SECRET_<NAME>` | One variable per environment secret. Secret `TEST_EMAIL` → `CHARLIE_SECRET_TEST_EMAIL`. Decrypted only on the runner; never sent to any third party. |

A test that hardcodes `https://staging.example.com` or an inline password will
pass in one place and fail everywhere else. A test that reads the contract runs
unchanged across every environment. **This is the difference between a plain
Playwright test and a Charlie one.**

Full details, a ready `playwright.config.ts`, and a `secret()` helper:
→ `references/charlie-contract.md`

## Workflow

Follow these steps in order. Load the referenced file when you reach that step.

1. **Scaffold the project (once).** If the repo has no Playwright project yet,
   start from Charlie's template so `playwright.config.ts` already reads the
   contract:
   ```bash
   npx giget@latest gh:justraman/charlie/examples/playwright-custom-tests my-e2e-tests
   ```
   Otherwise, make the existing `playwright.config.ts` read `CHARLIE_BASE_URL`
   and `CHARLIE_HEADERS` (see `references/charlie-contract.md`) and add
   `tests/charlie.ts` (the `secret()` helper).

2. **Write the tests.** Use role/label/text locators, web-first assertions, and
   Charlie's env contract for URLs and secrets. Do **not** add manual waits or
   hardcoded hosts. When you need a secret, read it via `secret('NAME')`, not
   `process.env` directly, so a missing secret fails loudly.
   → `references/playwright-essentials.md`

3. **Tag tests for selection.** Add tags like `@smoke`, `@login`, `@checkout`
   to test titles. Charlie's per-flow **grep** filter selects by tag, so one repo
   can back several code flows.
   → `references/importing-into-charlie.md`

4. **Run locally against the contract** to prove it works before importing:
   ```bash
   npm install && npx playwright install chromium
   CHARLIE_BASE_URL=https://staging.example.com \
   CHARLIE_SECRET_TEST_EMAIL=qa@example.com \
   CHARLIE_SECRET_TEST_PASSWORD=hunter2 \
     npx playwright test
   ```

5. **Import into Charlie.** Install the Charlie GitHub App on the repo, then
   create a flow of type **Custom Playwright code** pointing at `owner/repo`
   (optionally a ref, working directory, test filter, and grep).
   → `references/importing-into-charlie.md`

## How Charlie decides pass/fail (know this while writing)

Charlie runs `playwright test --reporter=list,json` and reads the JSON report:
the flow **passes** only when `stats.unexpected === 0` and there are no
top-level errors. Practical consequences:

- A committed `test.only` will be caught by `forbidOnly` on CI and fail the run —
  never commit `.only`.
- `test.skip`/`test.fixme` don't count as unexpected, so skipped tests won't fail
  a flow (but they also don't prove anything).
- Set `trace: 'retain-on-failure'` — Charlie uploads any trace it finds
  (`test-results/**/*.zip`) to the run's artifacts so you can open failures in the
  Playwright trace viewer.

## Common mistakes this skill prevents

- Hardcoding the base URL instead of using `baseURL` from `CHARLIE_BASE_URL`.
- Putting credentials in the repo instead of reading `CHARLIE_SECRET_*`.
- Forgetting `extraHTTPHeaders`, so auth/feature-flag headers are dropped and
  tests 401/404 only inside Charlie.
- Adding `page.waitForTimeout(...)` instead of web-first assertions — flaky in CI.
- Committing `test.only` — fails the whole flow under `forbidOnly`.
- No tags, so a code flow can't grep a subset and has to run the whole suite.
