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
| `CHARLIE_SECRET_<NAME>` | One var per environment secret (`TEST_EMAIL` → `CHARLIE_SECRET_TEST_EMAIL`). | `secret('NAME')` |

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

Read secrets through this helper, not `process.env` directly, so a missing
secret fails with a clear message instead of a confusing `undefined`.

```ts
export function secret(name: string): string {
  const value = process.env[`CHARLIE_SECRET_${name}`]
  if (value === undefined || value === '') {
    throw new Error(
      `Missing secret "${name}". Add it to the environment in Charlie, or set ` +
        `CHARLIE_SECRET_${name} locally to run this test outside Charlie.`,
    )
  }
  return value
}

/** Optional secret — returns undefined instead of throwing. */
export function optionalSecret(name: string): string | undefined {
  return process.env[`CHARLIE_SECRET_${name}`] || undefined
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
  not `test-email`). The env var is `CHARLIE_SECRET_` + that name verbatim.
- **Secrets never leave the runner.** They're decrypted only on the compute
  plane and exist as env vars for the duration of the run — safe to use, never
  logged by Charlie, never sent to an AI provider.
