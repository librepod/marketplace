# CA trust detection & the new-device trust helper — design

**Date:** 2026-10-18
**Status:** implemented (unit: 175 client tests pass · manual: UseDomainScreen helper verified headless against real TLS rejection; in-app banner pending one real-browser spot check)
**Scope:** `ui/packages/client` only — no server changes, no new endpoints
**Builds on:** first-run onboarding (2026-10-14-onboarding-setup-code-design.md)

## Problem

The device's TLS certificates chain to its own root CA (step-ca). That root is
installed on exactly one device — whichever browser ran the onboarding wizard.
Every later phone or laptop that joins the tailnet hits `https://<app>.<domain>`
with an untrusted chain and gets a raw browser interstitial, with no hint that
the fix is one certificate away. Users who click through "proceed anyway" limp
along: the exception blesses only that one origin, so every subdomain
(`id.` for SSO, each installed app) throws its own interstitial.

CA trust is **per device**; onboarding is **per install**. Nothing in the
product serves the gap between them.

## Research (what Sberbank does, and why it transfers)

Sberbank serves Минцифры-rooted certs to a population that mostly lacks the
root, and shows a "install Russian certificates" banner seconds after load.
Verified from their shipped SSR HTML (artifacts: `/tmp/sber-investigate/`):

- **Probe:** cross-origin `XMLHttpRequest` to `https://s.sberbank.ru/ru/person`
  — a *different host* than the page, signed by the same root, answering
  `204` + `Access-Control-Allow-Origin`. `onerror` + `status === 0` → unhide
  the banner (pre-rendered, `display:none`). Success → nothing.
- **The per-origin exception is the load-bearing trick:** a certificate
  click-through blesses only the origin it was granted on. A probe to a
  *different* host still fails — which is how the banner detects distrust even
  after the user proceeded past the interstitial. A same-origin probe would
  always succeed post-click-through and detect nothing.
- **Zero suppression by design:** no localStorage/cookie. The probe re-fires
  every load, so the banner is self-healing — it vanishes on the first visit
  after the CA is installed and never returns, because the probe stops failing.
- **The instructions live on plain HTTP** (`http://…/certificates`), reachable
  from the cert-less browser. The loop closes without any externally-trusted host.

Facts specific to our device that shape the design:

- The default leaf cert covers `*.<BASE_DOMAIN>` and `<BASE_DOMAIN>` — **no IP
  SANs** (verified on dev). Any HTTPS-by-IP probe fails on hostname mismatch
  even with the CA installed; probes must target the domain name.
- `fetch(url, { mode: 'no-cors' })` resolves opaque on any HTTP status and
  rejects only on network-level failure — which includes certificate
  rejection. That gives us Sber's semantics without their CORS header and
  without a dedicated `204` endpoint: any URL on the probed host works.
- Browsers deliberately hide the *reason* a fetch failed (cert vs DNS vs
  refused — all `TypeError`). Detection is therefore inference: a failure on a
  host the device is known to serve means the browser rejected the TLS chain.
  On the VPN path, DNS itself requires the tunnel, so an IP-surface failure can
  also mean "not connected yet" — the helper there covers both steps.

## Goals

1. A new device that opens the Marketplace sees actionable trust help instead
   of (or right after) a bare interstitial — including the click-through case,
   inside the app itself.
2. The help is self-healing: it disappears on the first load after the CA is
   installed. No settings, no persistence, no nagging.
3. Reuse the wizard's existing CA download (`GET /api/bootstrap/ca`, public)
   and per-platform instructions verbatim.

## Non-goals (v1)

- No signed-in "Add a device" tile / ControlsPanel entry.
- No WireGuard peer minting in the Marketplace UI (users add keys on the
  wg-easy page — reachable once the CA is installed; cert-before-key is the
  intended order).
- No plain-HTTP landing on `<domain>` itself (the interstitial cannot be
  preempted for users who type the HTTPS URL directly; the in-app banner
  catches them after they proceed).
- No changes to the CA, cert SANs, or Traefik.

## Design

Four client pieces. `TrustSheet` is shared material; the probe hook is one
mechanism consumed by two surfaces.

### 1. `TrustSheet` (extract from `TrustStep`)

Move the CA download button (`<a href="/api/bootstrap/ca" download>`, renders
on any origin that serves the SPA) and the per-platform `<details>`
instructions (iPhone/iPad, Android, macOS, Windows, Ubuntu — existing copy)
into one component in `ConnectivitySteps.tsx` (exported), consumed by
`TrustStep`, the banner, and `UseDomainScreen`. Pure refactor, no copy changes.

### 2. The probe — `useCaTrust` hook

```ts
// resolve(): 'trusted' | 'untrusted' | 'unknown' (loading/timeout)
fetch(probeUrl, { mode: 'no-cors' })   // rejects on cert rejection or network failure
```

- Raced against a **10 s timeout** (Sber's SDK uses the same constant); timeout
  counts as failure — on both surfaces the probed host is known-live from the
  page's own perspective, so "cannot even connect" is never *good* news.
- Runs **once per mount**; a `checkAgain()` re-runs it (the banner and the IP
  helper both offer this as "Check again" after the user installs the CA —
  no page reload needed, since the probe is not cached anywhere).
- Probe URL is **always a different origin than the page**:
  - in-app banner (served from `<domain>` or `marketplace.<domain>`) probes
    `https://id.<BASE_DOMAIN>/` — Casdoor, same root, guaranteed cross-origin
    from both app hosts;
  - `UseDomainScreen` (served from `http://<device-ip>`) probes
    `https://<BASE_DOMAIN>/api/health` — cross-origin by scheme+host, and
    `no-cors` means no CORS configuration is needed on either.

### 3. In-app banner (the Sber mechanic) — `AppShell`

Mounted in `AppShell` (signed-in surfaces only; it renders nothing during
onboarding, which has its own Trust step). Probe result `untrusted` ⇒ a
top strip, not dismissable, no persistence:

> ⚠ This browser doesn't trust this device's certificates — some apps won't
> open until the root certificate is installed. **Install the root
> certificate ▾**  ·  Check again

Expanding "Install the root certificate" shows `TrustSheet`. The strip
disappears entirely on any load where the probe succeeds. Copy follows the
product's "never blame the user" tone: it states the consequence and the fix.

### 4. `UseDomainScreen` upgrade (`http://<ip>`, state `finished`)

Today it says "your device lives at `<domain>`, open it". Keep that as the
trusted path. When the probe says `untrusted`, the screen gains the two-step
new-device helper (framing already proven in the wizard's bring-your-own
checklist — connection *and* trust, because from a VPN-less device the probe
cannot distinguish the two):

1. **Trust** — `TrustSheet` (download + platform instructions).
2. **Connect** — "Then get your connection key at `wg-easy.<domain>`" (works
   once the CA is in).
3. CTA flips from "Open `<domain>`" to "Check again", and to "Open
   `<domain>`" once the probe passes.

## Edge cases & decisions

| Case | Behavior |
|---|---|
| Firefox (own root store; OS store not consulted) | Same as any distrust — banner shows. The per-platform copy does not cover Firefox specifically (accepted v1 gap; follow-up). The instructions still install the CA correctly for Chromium- and Safari-based browsers. |
| Probe timeout (device busy / tunnel down) | Counts as failure; the strip's "Check again" is always available. No false "trusted". |
| Multiple tabs / repeat loads | Probe re-fires per load by design (Sber ships zero suppression deliberately); it's one opaque HEAD-ish request, cheap. |
| Onboarding wizard showing | No banner — `AppShell` isn't mounted under `RootGate`'s wizard screens; the wizard owns trust UX there. |
| `marketplace.<domain>` host | Probe still `id.<domain>` — cross-origin from both app hosts, one code path. |
| Browser with the CA, on VPN | Probe succeeds everywhere; zero UI change for existing good setups. |

## Testing

- **Unit (vitest + testing-library):** `useCaTrust` state machine
  (resolve/reject/timeout/`checkAgain`); banner renders only on `untrusted`,
  expands `TrustSheet`; `UseDomainScreen` shows helper vs. simple screen by
  probe result; `TrustStep` unchanged via existing specs (refactor safety).
- **Manual (Playwright rig, dev cluster):** the rig's `ignoreHTTPSErrors` is
  context-wide — it exempts the probe too, so the in-app *untrusted* state
  cannot be faithfully replayed headless with it on, and with it off the
  HTTPS app page will not load at all. Verification is therefore split:
  - `UseDomainScreen`: run the rig with `ignoreHTTPSErrors` **off**, arriving
    over `http://<ip>` (loads fine, no TLS involved) — the cross-origin probe
    to `https://<domain>` then fails naturally and the two-step helper must
    render; "Check again" still works.
  - In-app banner: unit-level fetch mocking for the state machine, plus one
    real-browser spot check from a profile that lacks the dev CA (any default
    browser on the LAN), where the banner must appear signed-in and vanish
    after the CA is installed + "Check again".

## Files touched (all under `ui/packages/client/src`)

- `pages/onboarding/ConnectivitySteps.tsx` — extract + export `TrustSheet`
- `hooks/useCaTrust.ts` — new probe hook
- `components/AppShell.tsx` — mount banner (new small component, likely
  co-located in AppShell or `components/TrustBanner.tsx`)
- `components/PreAuthScreens.tsx` — `UseDomainScreen` upgrade
- tests next to each

## Follow-ups (not v1)

- ControlsPanel "Add a device" tile with `http://<ip>` URL (+QR) and optional
  in-UI WireGuard peer minting (needs one authenticated endpoint reusing
  `WgEasyService`).
- Plain-HTTP trust landing on `<domain>` for users who type the HTTPS URL and
  freeze at the interstitial (needs an HTTP-entrypoint route exempt from the
  SSO redirect).
- Firefox-specific install instructions in the TrustSheet copy.
