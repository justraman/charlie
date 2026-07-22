import { expect, test } from '@playwright/test'
import { secret } from './charlie'

// Demonstrates using an environment secret. In Charlie, add TEST_EMAIL and
// TEST_PASSWORD as secrets on the environment; they arrive here as
// CHARLIE_SECRET_TEST_EMAIL / CHARLIE_SECRET_TEST_PASSWORD.
//
// This is illustrative — adjust the selectors and route to your own app. Tag it
// with @login so a Charlie code flow can select it via the "grep" filter.

test('user can sign in @login', async ({ page }) => {
  const email = secret('TEST_EMAIL')
  const password = secret('TEST_PASSWORD')

  await page.goto('/login')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole('button', { name: /sign in|log in/i }).click()

  // Landed somewhere authenticated (adjust to your app's post-login signal).
  await expect(page).toHaveURL(/dashboard|account|home/i)
})
