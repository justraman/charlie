import { expect, test } from '@playwright/test'

// A plain Playwright test. Because `baseURL` is set from CHARLIE_BASE_URL in
// playwright.config.ts, relative navigations run against whichever Charlie
// environment (dev / qa / staging / prod) the run targets — no code changes.

test('homepage loads @smoke', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.ok(), 'homepage should return a 2xx status').toBeTruthy()
  await expect(page).toHaveTitle(/.+/) // a non-empty <title>
})

test('has no console errors on load', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  expect(errors, `console errors:\n${errors.join('\n')}`).toHaveLength(0)
})
