import { test, expect } from '@playwright/test'

// The regression this file exists for: on a fresh cluster the UI used to
// bounce straight to /api/auth/login → an unresolvable IdP host. Bootstrap
// mode must own the first paint instead.
//
// NB: the shared Tier-1 server runs with BOOTSTRAP_MODE_OVERRIDE=ready (see
// tier1.config.ts) so the rest of the suite sees the authenticated app.
// The waiting-mode WakingScreen first-paint is therefore pinned at unit
// level (RootGate.test.tsx); here we pin what only a real browser can:
// the pre-auth surface never redirects into the auth flow, and the wizard
// is reachable and renders for an unauthenticated visitor.
test('authenticated visit renders the app, never an SSO redirect', async ({ page }) => {
  await page.goto('/')
  // RootGate passed through (ready + domain arrival) and the shell mounted —
  // this pins the implicit tier-1 invariant: ORIGIN 'localhost' classifies
  // as a domain arrival, so the override makes RootGate a pass-through.
  // Change ORIGIN to an IP and every spec would hang behind the wizard.
  await expect(page.getByRole('heading', { name: 'My Apps' })).toBeVisible()
  await expect(page).not.toHaveURL(/api\/auth/)
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/bootstrap/status')
    return res.json()
  })
  expect(status.mode).toBe('ready')
})

test('the wizard renders for an unauthenticated visitor, no SSO redirect', async ({ browser }) => {
  // Fresh context — no minted session cookie: the deep-linked wizard is the
  // pre-auth experience and must not bounce into /api/auth/login. Which STEP
  // renders depends on shared-server state (an earlier authenticated poll
  // latches claimed), so pin the mode-agnostic invariant: the wizard's
  // progress rail is on screen — not the app, not a redirect.
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/onboarding')
  await expect(page.getByRole('list', { name: 'setup progress' })).toBeVisible({ timeout: 15_000 })
  await expect(page).not.toHaveURL(/api\/auth/)
  await context.close()
})
