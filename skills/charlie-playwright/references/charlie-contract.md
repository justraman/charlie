# The Charlie environment contract

Charlie passes the selected environment into your Playwright process as plain
environment variables. There is no SDK — everything is `process.env`. Wire these
in once (config + a tiny helper) and every test inherits them.

## Variables Charlie sets

| Variable | Meaning | Wire it into |
|---|---|---|
| `CHARLIE_BASE_URL` | The environment's `base_url`. | `use.baseURL` |
| `PLAYWRIGHT_BASE_URL` | Same value, for configs that already read this name. | `use.baseURL` |
| `CHARLIE_HEADERS` | JSON string of the environment's default headers. | `use.extraHTTPHeaders` |
| `<NAME>` | Each environment secret, under its own name (`TEST_EMAIL` → `process.env.TEST_EMAIL`). | `secret('NAME')` |
| `CHARLIE_SECRET_<NAME>` | The same secret, prefixed. Also set; the only form for a reserved name (below). | `secret('NAME')` |

### Reserved secret names

A secret is exported under its own name unless that would take over a variable
Charlie sets or the run depends on. These reach the test **only** as
`CHARLIE_SECRET_<NAME>`:

`CHARLIE_BASE_URL`, `CHARLIE_HEADERS`, `CHARLIE_RUN_TOKEN`, `CHARLIE_REPORT_NAME`,
`PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_JSON_OUTPUT_NAME`, `PATH`, `HOME`, `PWD`,
`SHELL`, `TMPDIR`, `CI`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `LD_PRELOAD`,
`LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`

Same for a name that isn't a legal env var name (`[A-Za-z_][A-Za-z0-9_]*`). The
run's `log.txt` names any secret it skipped, never its value. Prefer secret names
that avoid this list entirely.

When you run the repo locally these are unset, so fall back to a local dev
server. That keeps the repo runnable on its own while staying Charlie-driven.

## playwright.config.ts

```ts
import { defineConfig, devices } from '@playwright/test'

// Charlie sets CHARLIE_BASE_URL at run time; fall back locally.
const baseURL = process.env.CHARLIE_BASE_URL || 'http://localhost:3000'

// Environment default headers (auth, feature flags), forwarded on every request.
const extraHTTPHeaders = JSON.parse(
  process.env.CHARLIE_HEADERS || '{}',
) as Record<string, string>

export default defineConfig({
  testDir: './tests',
  // Never let a committed test.only pass CI — Charlie fails the flow on it anyway.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Your local reporters. Charlie overrides with `--reporter=list,json` on the
  // CLI so it can parse pass/fail — you don't need to add the json reporter here.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    extraHTTPHeaders,
    // Charlie uploads any trace it finds to the run's artifacts.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
```

## tests/charlie.ts — the secret helper

`process.env.TEST_EMAIL` works directly — Charlie exports secrets under their own
names. Prefer this helper anyway: a missing secret then fails with a clear
message instead of a confusing `undefined`, and it also covers the prefixed form
used for reserved names.

```ts
function read(name: string): string | undefined {
  return process.env[name] || process.env[`CHARLIE_SECRET_${name}`] || undefined
}

export function secret(name: string): string {
  const value = read(name)
  if (value === undefined || value === '') {
    throw new Error(
      `Missing secret "${name}". Add it to the environment in Charlie, or set ` +
        `${name} locally to run this test outside Charlie.`,
    )
  }
  return value
}

/** Optional secret — returns undefined instead of throwing. */
export function optionalSecret(name: string): string | undefined {
  return read(name)
}
```

Usage in a test:

```ts
import { expect, test } from '@playwright/test'
import { secret } from './charlie'

test('user can sign in @login', async ({ page }) => {
  await page.goto('/login') // relative → resolves against CHARLIE_BASE_URL
  await page.getByLabel(/email/i).fill(secret('TEST_EMAIL'))
  await page.getByLabel(/password/i).fill(secret('TEST_PASSWORD'))
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await expect(page).toHaveURL(/dashboard|account/i)
})
```

## Rules that keep tests portable

- **Always relative navigation.** `page.goto('/checkout')`, never a full URL.
- **Never hardcode secrets or headers.** The only source is the Charlie env.
- **Name secrets in Charlie exactly** as the `<NAME>` you read (`TEST_EMAIL`,
  not `test-email`). The env var *is* that name, verbatim.
- **Secrets never leave the runner.** They're decrypted only on the compute
  plane and exist as env vars for the duration of the run — safe to use, never
  logged by Charlie, never sent to an AI provider.
