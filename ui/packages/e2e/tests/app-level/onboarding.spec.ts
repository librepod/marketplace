import { test, expect } from '@playwright/test'

// The regression this file exists for: on a fresh cluster (no DNS for
// *.libre.pod) the UI used to bounce straight to /api/auth/login → an
// unresolvable id host. Bootstrap mode must own the first paint instead.
test('fresh visit shows the waking screen, never an SSO redirect', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /waking up/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/raw device address/i)).toBeVisible()
  // no redirect into the auth flow, and no navigation away from the SPA
  await expect(page).not.toHaveURL(/api\/auth/)
  // the status endpoint answered (the page rendered from real data)
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/bootstrap/status')
    return res.json()
  })
  expect(status.mode).toBe('waiting')
})
