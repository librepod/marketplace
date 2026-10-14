import { test, expect } from '@playwright/test'

// The regression this file exists for: on a fresh device the UI used to bounce
// straight to /api/auth/login → an unresolvable IdP host. RootGate must decide
// before any SSO redirect can fire.
//
// NB: the shared Tier 1 server runs with BOOTSTRAP_MODE_OVERRIDE=finished (see
// tier1.config.ts), and every spec carries a minted SSO session. The wizard,
// Resume and WakingScreen first paints are pinned at unit level
// (RootGate.test.tsx, OnboardingPage.test.tsx); here we pin what only a real
// browser can: the app mounts and the auth flow is never entered.
test('authenticated visit renders the app, never an SSO redirect', async ({ page }) => {
  await page.goto('/')
  // ORIGIN 'localhost' classifies as a domain arrival, so "finished" makes
  // RootGate a pass-through. Change ORIGIN to an IP and every spec would hang
  // on the UseDomainScreen.
  await expect(page.getByRole('heading', { name: 'My Apps' })).toBeVisible()
  await expect(page).not.toHaveURL(/api\/auth/)
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/bootstrap/status')
    return res.json()
  })
  expect(status.state).toBe('finished')
})
