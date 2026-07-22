import { defineConfig, devices } from '@playwright/test'

// Charlie's contract for `code` flows (see docs/CUSTOM_TESTS.md):
//   CHARLIE_BASE_URL       the selected environment's base URL
//   CHARLIE_HEADERS        JSON of the environment's default headers
//   CHARLIE_SECRET_<NAME>  one variable per environment secret
//
// When run locally (outside Charlie) these are unset, so we fall back to a local
// dev server. Nothing here is Charlie-specific beyond reading these env vars —
// it's a plain Playwright config.

const baseURL = process.env.CHARLIE_BASE_URL || 'http://localhost:3000'

// Environment default headers (auth, feature flags, etc.), forwarded on every
// request. Empty object when running standalone.
const extraHTTPHeaders = JSON.parse(process.env.CHARLIE_HEADERS || '{}') as Record<string, string>

export default defineConfig({
  testDir: './tests',
  // Fail the build if test.only is committed; retry once on CI to smooth flakes.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Charlie overrides the reporter on the CLI (`--reporter=list,json`) so it can
  // parse pass/fail; this list is what you get when running the repo yourself.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    extraHTTPHeaders,
    // Charlie uploads any trace it finds so you can open failures in the
    // Playwright trace viewer from the run's artifacts.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
