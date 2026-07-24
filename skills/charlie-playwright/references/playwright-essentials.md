# Playwright essentials (write resilient tests)

Condensed best practices for writing tests that stay green in CI. These are
standard Playwright guidance; the Charlie-specific rules live in
`charlie-contract.md`. When in doubt, prefer the built-in behavior (auto-waiting,
web-first assertions) over manual control.

## Locators: query like a user

Prefer role-, label-, and text-based locators. They survive markup changes and
read like the user's intent. Order of preference:

1. `page.getByRole('button', { name: /submit/i })` — accessible role + name.
2. `page.getByLabel('Email')` — form fields by their label.
3. `page.getByText('Welcome back')` / `getByPlaceholder` / `getByTitle`.
4. `page.getByTestId('cart-total')` — add `data-testid` when nothing semantic
   fits. Stable, but couples the test to markup.
5. CSS/XPath — last resort; brittle.

Chain and filter instead of indexing:

```ts
page.getByRole('listitem').filter({ hasText: 'Product A' }).getByRole('button', { name: 'Add' })
```

## Assertions: web-first, auto-retrying

`expect(locator).*` assertions **auto-wait and retry** until they pass or time
out. This is how you avoid flakiness — never sleep, assert instead.

```ts
await expect(page.getByText('Order placed')).toBeVisible()
await expect(page).toHaveURL(/\/confirmation/)
await expect(page.getByRole('row')).toHaveCount(3)
await expect(page.getByTestId('total')).toHaveText('$42.00')
```

Do **not** assert on values you read manually (`expect(await locator.textContent())`)
— that snapshot doesn't retry and races the UI.

## Never use fixed waits

```ts
// ❌ flaky — the number is always wrong somewhere
await page.waitForTimeout(3000)

// ✅ wait for the actual condition
await expect(page.getByRole('progressbar')).toBeHidden()
await page.getByRole('button', { name: 'Continue' }).click()
```

Actions (`click`, `fill`, …) already auto-wait for the element to be actionable,
so you rarely need explicit waits at all. When you must wait on the network, wait
for the specific response:

```ts
await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/checkout') && r.ok()),
  page.getByRole('button', { name: 'Pay' }).click(),
])
```

## Structure

- One user journey per `test`; keep them independent (no shared mutable state,
  no ordering dependency). Charlie may shard them across machines.
- Use `test.beforeEach` for common setup (e.g. logging in) — or better, share a
  logged-in state via a storage-state fixture for speed.
- Group related tests with `test.describe`.
- Give tests descriptive titles and tag them (`@smoke`, `@login`) so Charlie's
  grep can select subsets — see `importing-into-charlie.md`.
- Never commit `test.only`; it fails a Charlie run under `forbidOnly`.

## Debugging locally

```bash
npx playwright test --ui            # time-travel UI, pick locators
npx playwright test --debug         # step through with the inspector
npx playwright codegen <url>        # record actions into a starting test
npx playwright show-trace trace.zip # open a trace (same file Charlie uploads)
```

Keep `trace: 'retain-on-failure'` in the config so the trace Charlie uploads on a
failed run opens in exactly this viewer.

## Authentication pattern

Reading `CHARLIE_SECRET_*` in every test is fine, but for suites that all need a
logged-in user, sign in once and reuse the storage state:

```ts
// global-setup style, or a project dependency
await page.goto('/login')
await page.getByLabel(/email/i).fill(secret('TEST_EMAIL'))
await page.getByLabel(/password/i).fill(secret('TEST_PASSWORD'))
await page.getByRole('button', { name: /sign in/i }).click()
await page.context().storageState({ path: 'storageState.json' })
```

Then set `use: { storageState: 'storageState.json' }` for the authenticated
project. The credentials still come from Charlie secrets — only the session is
cached.
