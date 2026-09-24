# First-Run Onboarding ("Claim Your Device") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A raw-IP first-run wizard that takes a fresh cluster from `http://<device-ip>` to a claimed admin, trusted root CA, a connected WireGuard tunnel, and graduation to `https://<base-domain>` — replacing today's dead SSO redirect.

**Architecture:** The browser never reaches `id.<domain>`/wg-easy mid-tour; the NestJS server proxies everything over in-cluster DNS. Bootstrap mode is derived from one live fact: *can the server still log into Casdoor as the built-in admin with the factory password* (`admin`/`123`)? Takeover (create the fixed owner `admin` in org `librepod` — `admin@<base-domain>` — with the user-chosen password, then re-password the built-in admin to random) closes that window by construction. wg-easy v15 has no SSO but accepts `Authorization: Basic admin:<password>` on every API call; the wizard rotates that factory password to the **same chosen password** (one password for the whole device) and persists it to a Secret. A signed `mp_onboarding` cookie (minted only while unclaimed) gates the wizard's WireGuard endpoints so they die with the tour.

**Tech Stack:** NestJS 11 (server), React 19 + TanStack Query v5 + react-router (client), Tailwind v4/shadcn components (existing), vitest + Playwright Tier 1 (tests). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-onboarding-flow-design.md` (+ product record `ui/PRODUCT.md`). Five steps (Welcome → Claim → Trust CA → Connect → Graduate at apex), three pre-auth screens (Waking / Onboarding / Use-your-domain), owner-only, full-service wizard, resume-from-cluster-truth.

## Global Constraints

- No new npm dependencies. No new frameworks. Reuse `@/components/ui/*` (button, card, input), `FullScreenSpinner`, `STATUS_DOT` conventions.
- Casdoor is v3.106.0 (live image `casbin/casdoor:3.106.0`), wg-easy is v15.3 (`ghcr.io/wg-easy/wg-easy:15.3`). API shapes below were read from those exact tags.
- SSO-over-IP stays impossible (https redirect_uri + Secure cookies). Never "fix" that; the tour graduates the user off the IP.
- Factory credentials: casdoor built-in `admin`/`123` (`CASDOOR_ADMIN_DEFAULT_PASSWORD` overridable); wg-easy `admin`/`ChangeMeOnFirstLogin!` (Secret `wg-easy-admin`, key `INIT_PASSWORD`, mounted at `/etc/wg-easy/INIT_PASSWORD`).
- In-cluster endpoints: casdoor `http://casdoor.casdoor.svc.cluster.local` (Service port 80), wg-easy `http://wg-easy.wg-easy.svc.cluster.local` (Service port 80 → 51821).
- Commit/PR hygiene: never reference device/cluster hostnames in commits or PRs.
- Test commands run from `ui/`. Server tests: `npm test --workspace=packages/server -- <path>`. Client tests: `npm run test --workspace=packages/client -- <path>`.
- Commit after every green test cycle, conventional-commit style (`feat(ui): …` / `feat(wg-easy): …`).

## Resolved API mechanics (evidence, do not re-derive)

**Casdoor v3.106.0** (source: casbin/casdoor @ v3.106.0):

- `POST /api/login` — anonymous (that's how the login page works). JSON body: `{type:"login", application:"app-built-in", organization:"built-in", username, password, autoSignin:true}`. Wrong password → HTTP 200 `{status:"error", msg:…}`. Success → `{status:"ok", …}` + beego `Set-Cookie` headers. A session cookie is the ONLY auth `/api/set-password` accepts (`user.go:571` requires `GetSessionUsername()`).
- `POST /api/set-password` — **form-encoded** `userOwner=built-in&userName=admin&oldPassword=123&newPassword=<new>` with the session cookie. Rejects passwords containing spaces; org `built-in` complexity is `AtLeast6`.
- `GET /api/get-organization?id=librepod` → `{status:"ok", data:<org|null>}`. `POST /api/add-organization` JSON `{name:"librepod", displayName:"LibrePod"}` (server fills accountItems/passwordOptions/countryCodes defaults).
- `GET /api/get-user?id=librepod/<name>` → `{status:"ok", data:<user|null>}`. `POST /api/add-user` JSON `{owner:"librepod", name, displayName, email, password, isAdmin:true, type:"normal-user"}`.
- The owner MUST live in org `librepod`: the marketplace-ui Casdoor application is bound to it (`ssoclient.yaml:17`), and `CheckLoginPermission` rejects users from other orgs.

**wg-easy v15.3** (source: wg-easy @ v15.3.0, `src/server/utils/session.ts:47-93`):

- Every `/api/*` route accepts `Authorization: Basic base64("admin:"+password)` — validated against the DB user the unattended setup created from `INIT_USERNAME`/`INIT_PASSWORD`. No session dance needed.
- `GET /api/client` → array of `{clientId, name, enabled, latestHandshakeAt: <ISO string|null>, …}`.
- `POST /api/client` JSON `{name, expiresAt: null}` → `{success:true, clientId}`.
- `GET /api/client/<id>/configuration` → `text/plain` WireGuard config (+ attachment header).
- `GET /api/client/<id>/qrcode.svg` → `image/svg+xml` QR of the config.
- `POST /api/me/password` JSON `{currentPassword, newPassword}` → `{success:true}`.

## Design decisions locked during planning (beyond the brief)

1. **Claim = ensure org → ensure the fixed owner user → randomize built-in admin's password** (in that order; every step idempotent so a failure is retried on the still-valid factory credential). The owner is a single fixed identity: `name: admin`, org `librepod`, `email: admin@<base-domain>`, `isAdmin: true` (org admin — manages users; global objects stay with the sso-controller). The wizard asks for a password only — no username, no email.
2. **One password for the whole device.** wg-easy has no SSO, so at claim time the wizard rotates the wg-easy factory password to the SAME password the user just chose (`adoptPassword`): persist to Secret `marketplace-ui-wg-easy` FIRST (so a wg-easy outage during claim doesn't lose it — the lazy `ensurePassword()` picks it up from the Secret once wg-easy is reachable), then rotate best-effort. Accepted trade-offs, stated once: the SSO admin password now lives (base64) in that Secret — RBAC-scoped to this ServiceAccount, reasonable on a single-admin cluster — and a later Casdoor password change does NOT propagate to wg-easy (a future Users panel can re-sync). This also closes the "committed default password on a public repo" hole on the wg UI (reachable via `--resolve wg.libre.pod:<ip>` even without DNS).
3. **`mp_onboarding` cookie** (HMAC via `SessionService`, `sub:"onboarding"`, 8h TTL, httpOnly, NOT Secure — the wizard IS the http://ip experience): minted by `/api/bootstrap/status` and `/api/bootstrap/claim` **only while unclaimed**. It is proof-of-presence before the door closed and gates all WireGuard endpoints; it expires with the tour.
4. **Mode derivation:** `waiting` = casdoor unreachable · `onboarding` = factory login still works · `ready` = claimed. RootGate additionally uses `arrival` (ip/domain) and `lastHandshakeAt` to pick between wizard / use-domain screen / normal app (see Task 10).
5. **Graduation stickiness:** the wizard's connect step watches `latestHandshakeAt` live; RootGate shows the use-domain screen only once a handshake has been seen. A later-disconnected tunnel honestly resumes the wizard at the connect step.
6. **`GET /api/bootstrap/status` never mutates casdoor** (probe is a login attempt, which is write-free). wg-easy rotation happens in `claim` (best-effort) or lazily inside wg API calls — not in status polls (rotation in a GET would be a side effect on a poll).

## File Structure

```
ui/packages/shared/src/types.ts                      # + onboarding types (type-only package)
ui/packages/server/src/onboarding/
  onboarding.module.ts                               # module wiring
  casdoor-admin.service.ts (+ .spec.ts)              # factory probe + takeover
  wg-easy.service.ts (+ .spec.ts)                    # Basic-auth wg-easy client + rotation
  wg-easy-secret.store.ts (+ .spec.ts)               # Secret marketplace-ui-wg-easy via k8s API
  onboarding.guard.ts                                # mp_onboarding cookie guard
  bootstrap.controller.ts (+ .spec.ts)               # GET status/ca, POST claim
  wireguard.controller.ts (+ .spec.ts)               # GET list, POST peer, config/QR passthrough
ui/packages/server/src/auth/auth.guard.ts            # isPublic: + /api/bootstrap/
ui/packages/server/src/app.module.ts                 # + OnboardingModule
ui/packages/client/src/hooks/useBootstrapStatus.ts   # poll, plain fetch (never apiFetch)
ui/packages/client/src/components/RootGate.tsx (+test)# mode router (replaces AuthGate wrap)
ui/packages/client/src/components/PreAuthScreens.tsx (+test) # WakingScreen + UseDomainScreen
ui/packages/client/src/pages/onboarding/OnboardingPage.tsx (+test) # the wizard (5 steps)
ui/packages/client/src/router.tsx                    # RootGate wrap + /onboarding route
ui/packages/e2e/tests/app-level/onboarding.spec.ts   # the no-redirect regression
apps/wg-easy/base/kustomization.yaml                 # reflect source annotations + stable name
apps/marketplace-ui/base/configmap.yaml              # CASDOOR_BASE_URL, WGEASY_BASE_URL
apps/marketplace-ui/base/serviceaccount.yaml         # Role+RoleBinding for the wg secret
apps/marketplace-ui/base/kustomization.yaml          # empty reflected secret stub
apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml  # env + mounts
```

Manifests are deployed by the existing publish flow — no other cluster objects are created by hand.

---

### Task 1: Shared types + AuthGuard exemption + OnboardingModule skeleton

**Files:**
- Modify: `ui/packages/shared/src/types.ts` (append)
- Modify: `ui/packages/server/src/auth/auth.guard.ts`
- Create: `ui/packages/server/src/onboarding/onboarding.module.ts`
- Modify: `ui/packages/server/src/app.module.ts`

**Interfaces:**
- Produces: `OnboardingMode`, `ArrivalKind`, `OnboardingStatus`, `WgPeer` (shared types used by every later task); `OnboardingModule` imported by `AppModule`.

- [ ] **Step 1: Append onboarding types to the shared package**

`ui/packages/shared/src/types.ts` (append; the package is type-only — interfaces only, no runtime code):

```ts
/** First-run onboarding. `mode` is derived from one live fact: whether the
 * server can still log into Casdoor as the built-in admin with the factory
 * password. `ready` therefore means "claimed", not "tour finished" — the
 * wizard keeps running under `ready` until the tunnel handshakes. */
export type OnboardingMode = 'waiting' | 'onboarding' | 'ready'

/** How the browser reached the server: raw device IP vs <name>.<baseDomain>. */
export type ArrivalKind = 'ip' | 'domain'

export interface OnboardingStatus {
  mode: OnboardingMode
  arrival: ArrivalKind
  baseDomain: string
  casdoorUp: boolean
  wgEasyUp: boolean
  /** null = unknown (casdoor unreachable or wg credentials unavailable) */
  adminClaimed: boolean | null
  peerCount: number | null
  /** ISO timestamp of the most recent WireGuard handshake, null if none */
  lastHandshakeAt: string | null
}

export interface WgPeer {
  clientId: string
  name: string
  enabled: boolean
  latestHandshakeAt: string | null
}
```

- [ ] **Step 2: Exempt the bootstrap prefix from the auth guard**

`ui/packages/server/src/auth/auth.guard.ts` — replace `isPublic`:

```ts
  /** Public surface: liveness/readiness probes, the auth endpoints themselves
   * (login must be reachable without a session), and the first-run bootstrap
   * endpoints (the wizard runs before any SSO can exist — gating them on a
   * session would be the raw-IP dead end this flow exists to fix). */
  private isPublic(url: string): boolean {
    return (
      url === '/api/health' ||
      url.startsWith('/api/auth/') ||
      url.startsWith('/api/bootstrap/')
    );
  }
```

- [ ] **Step 3: Create the module**

`ui/packages/server/src/onboarding/onboarding.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CasdoorAdminService } from './casdoor-admin.service';
import { WgEasySecretStore } from './wg-easy-secret.store';
import { WgEasyService } from './wg-easy.service';
import { OnboardingGuard } from './onboarding.guard';
import { BootstrapController } from './bootstrap.controller';
import { WireguardController } from './wireguard.controller';

@Module({
  imports: [AuthModule], // SessionService (HMAC signing for the onboarding cookie)
  controllers: [BootstrapController, WireguardController],
  providers: [CasdoorAdminService, WgEasyService, WgEasySecretStore, OnboardingGuard],
})
export class OnboardingModule {}
```

- [ ] **Step 4: Register in AppModule**

`ui/packages/server/src/app.module.ts` — add to imports (after `AuthModule`):

```ts
import { OnboardingModule } from './onboarding/onboarding.module';
// ...
    AuthModule,
    OnboardingModule,
```

- [ ] **Step 5: Compile gate**

Run: `cd ui && npm run build 2>&1 | tail -5` — expected: fails, the six referenced files don't exist yet. This only verifies wiring syntax so far; the real gate comes per-file below. If the error is anything other than "cannot find module ./casdoor-admin.service" style, fix the wiring first.

- [ ] **Step 6: Commit**

```bash
git add ui/packages/shared/src/types.ts ui/packages/server/src/auth/auth.guard.ts ui/packages/server/src/onboarding/ ui/packages/server/src/app.module.ts
git commit -m "feat(ui): onboarding module skeleton + shared bootstrap types"
```

---

### Task 2: CasdoorAdminService (factory probe + takeover)

**Files:**
- Create: `ui/packages/server/src/onboarding/casdoor-admin.service.ts`
- Test: `ui/packages/server/src/onboarding/casdoor-admin.service.spec.ts`

**Interfaces:**
- Produces: `CasdoorAdminService.probeFactoryLogin(): Promise<'ok' | 'rejected' | 'unreachable'>` and `claim(input: {password: string}): Promise<void>` — creates the fixed owner `admin` / `admin@<base-domain>` in org `librepod` (throws `ConflictException` when already claimed).

- [ ] **Step 1: Write the failing tests**

`ui/packages/server/src/onboarding/casdoor-admin.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CasdoorAdminService } from './casdoor-admin.service';

function jsonRes(body: unknown, opts: { setCookie?: string[] } = {}) {
  const headers = new Headers();
  (opts.setCookie ?? []).forEach((c) => headers.append('set-cookie', c));
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe('CasdoorAdminService', () => {
  beforeEach(() => {
    process.env.CASDOOR_BASE_URL = 'http://casdoor.test';
    process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD = '123';
    process.env.BASE_DOMAIN = 'libre.pod';
  });
  afterEach(() => vi.spyOn(global, 'fetch').mockRestore());

  it('probeFactoryLogin: ok when the factory password still works', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ status: 'ok' }));
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('ok');
  });

  it('probeFactoryLogin: rejected on wrong password', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      jsonRes({ status: 'error', msg: 'password incorrect' }),
    );
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('rejected');
  });

  it('probeFactoryLogin: unreachable on network error / empty base URL', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('unreachable');
    delete process.env.CASDOOR_BASE_URL;
    expect(await new CasdoorAdminService().probeFactoryLogin()).toBe('unreachable');
  });

  it('claim: ensures org, creates the fixed owner, then closes the factory window', async () => {
    const calls: Array<{ url: string; body?: string; headers: Record<string, string> }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      calls.push({
        url: String(url),
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const u = String(url);
      if (u.endsWith('/api/login')) return jsonRes({ status: 'ok' }, { setCookie: ['casdoor_session=abc'] });
      if (u.includes('/api/get-organization')) return jsonRes({ status: 'ok', data: null });
      if (u.includes('/api/get-user')) return jsonRes({ status: 'ok', data: null });
      return jsonRes({ status: 'ok' });
    });
    await new CasdoorAdminService().claim({ password: 'hunter2hunter2' });

    const urls = calls.map((c) => c.url.replace('http://casdoor.test', ''));
    expect(urls).toEqual([
      '/api/login',
      '/api/get-organization?id=librepod',
      '/api/add-organization',
      '/api/get-user?id=librepod/admin',
      '/api/add-user',
      '/api/set-password',
    ]);
    // fixed-identity owner created in the platform org, factory window closed last
    const addUser = JSON.parse(calls[4]!.body!);
    expect(addUser).toMatchObject({
      owner: 'librepod',
      name: 'admin',
      email: 'admin@libre.pod',
      isAdmin: true,
      password: 'hunter2hunter2',
    });
    const setPassword = new URLSearchParams(calls[5]!.body!);
    expect(setPassword.get('userOwner')).toBe('built-in');
    expect(setPassword.get('userName')).toBe('admin');
    expect(setPassword.get('oldPassword')).toBe('123');
    expect(setPassword.get('newPassword')).not.toBe('123');
    // every post-login call replays the session cookie
    expect(calls[5]!.headers['cookie'] ?? (calls[5]!.headers as any).cookie).toContain('casdoor_session=abc');
  });

  it('claim: skips existing org/user (idempotent retry)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/login')) return jsonRes({ status: 'ok' }, { setCookie: ['casdoor_session=abc'] });
      if (u.includes('/api/get-organization')) return jsonRes({ status: 'ok', data: { name: 'librepod' } });
      if (u.includes('/api/get-user')) return jsonRes({ status: 'ok', data: { name: 'admin' } });
      return jsonRes({ status: 'ok' });
    });
    await new CasdoorAdminService().claim({ password: 'hunter2hunter2' });
    // only login + the two existence GETs + set-password
    expect((global.fetch as any).mock.calls.length).toBe(4);
  });

  it('claim: ConflictException when the factory credential is already dead', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(jsonRes({ status: 'error', msg: 'wrong password' }));
    await expect(new CasdoorAdminService().claim({ password: 'yyyyyyyy' })).rejects.toThrow(ConflictException);
  });

  it('claim: rejects passwords casdoor would refuse (spaces)', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/login')) return jsonRes({ status: 'ok' }, { setCookie: ['a=b'] });
      if (u.includes('/api/get-organization')) return jsonRes({ status: 'ok', data: {} });
      if (u.includes('/api/get-user')) return jsonRes({ status: 'ok', data: {} });
      // set-password: space in newPassword
      return jsonRes({ status: 'error', msg: 'New password cannot contain blank space.' });
    });
    await expect(new CasdoorAdminService().claim({ password: 'valid password' })).rejects.toThrow('set-password failed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/casdoor-admin.service.spec.ts`
Expected: FAIL — module `./casdoor-admin.service` does not exist.

- [ ] **Step 3: Write the implementation**

`ui/packages/server/src/onboarding/casdoor-admin.service.ts`:

```ts
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';

interface CasdoorResponse {
  status: string;
  msg?: string;
  data?: unknown;
}

export type FactoryProbe = 'ok' | 'rejected' | 'unreachable';

export interface ClaimInput {
  password: string;
}

/**
 * First-run takeover of the Casdoor built-in admin. The factory credential
 * (admin/123, see apps/casdoor-sso-controller/base/casdoor-sso-controller.env)
 * is simultaneously the bootstrap detector, the claim authorization, and the
 * security gate: once the takeover randomizes the built-in password, all three
 * evaporate together. No marker state exists anywhere.
 */
@Injectable()
export class CasdoorAdminService {
  private readonly logger = new Logger(CasdoorAdminService.name);
  private readonly baseUrl = (process.env.CASDOOR_BASE_URL ?? '').replace(/\/$/, '');
  private readonly factoryPassword = process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD ?? '123';
  private readonly org = process.env.CASDOOR_ORG_NAME ?? 'librepod';

  /** Anonymous password login against the same endpoint the browser login
   * page uses. On success Casdoor sets a beego session cookie — the only
   * authorization /api/set-password accepts — so capture and return it. */
  private async login(password: string): Promise<{ ok: boolean; cookie: string; msg?: string }> {
    const res = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'login',
        application: 'app-built-in',
        organization: 'built-in',
        username: 'admin',
        password,
        autoSignin: true,
      }),
    });
    const json = (await res.json().catch(() => ({ status: 'error' }))) as CasdoorResponse;
    const setCookies = res.headers.getSetCookie?.() ?? [];
    return { ok: json.status === 'ok', cookie: setCookies.join('; '), msg: json.msg };
  }

  /** 'ok' = factory window open (onboarding mode), 'rejected' = claimed,
   * 'unreachable' = casdoor still converging (waiting mode). */
  async probeFactoryLogin(): Promise<FactoryProbe> {
    if (!this.baseUrl) return 'unreachable';
    try {
      const r = await this.login(this.factoryPassword);
      return r.ok ? 'ok' : 'rejected';
    } catch (err) {
      this.logger.debug(`factory login probe failed: ${String(err)}`);
      return 'unreachable';
    }
  }

  /** Take over: ensure the platform org, ensure the fixed owner user in it,
   * then randomize the built-in admin's password. Every step is idempotent —
   * a failure is retried on the still-valid factory credential. The window
   * closes LAST, so an aborted claim never locks the cluster. */
  async claim(input: ClaimInput): Promise<void> {
    const login = await this.login(this.factoryPassword);
    if (!login.ok) {
      throw new ConflictException('bootstrap already claimed');
    }
    await this.ensureOrganization(login.cookie);
    await this.ensureOwnerUser(login.cookie, input.password);
    await this.setPassword(login.cookie, crypto.randomBytes(24).toString('base64url'));
  }

  private async ensureOrganization(cookie: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/get-organization?id=${this.org}`, {
      headers: { cookie },
    });
    const json = (await res.json()) as CasdoorResponse;
    if (json.status === 'ok' && json.data) return;
    // The controller normally creates the platform org; this is an idempotent
    // belt-and-suspenders so a fresh cluster can never wedge the wizard.
    await this.postJson('/api/add-organization', cookie, {
      name: this.org,
      displayName: 'LibrePod',
    });
  }

  /** The single fixed owner identity: `admin` in the platform org. No
   * username is ever chosen — the wizard asks for a password only. */
  private async ensureOwnerUser(cookie: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/get-user?id=${this.org}/admin`, {
      headers: { cookie },
    });
    const json = (await res.json()) as CasdoorResponse;
    if (json.status === 'ok' && json.data) return;
    await this.postJson('/api/add-user', cookie, {
      owner: this.org,
      name: 'admin',
      displayName: 'admin',
      email: `admin@${process.env.BASE_DOMAIN ?? 'libre.pod'}`,
      password,
      isAdmin: true, // org admin of the platform org — manages users, not global objects
      type: 'normal-user',
    });
  }

  /** Randomize the built-in admin's password — closes the factory window. */
  private async setPassword(cookie: string, newPassword: string): Promise<void> {
    const body = new URLSearchParams({
      userOwner: 'built-in',
      userName: 'admin',
      oldPassword: this.factoryPassword,
      newPassword,
    });
    const res = await fetch(`${this.baseUrl}/api/set-password`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = (await res.json().catch(() => ({ status: 'error' }))) as CasdoorResponse;
    if (json.status !== 'ok') {
      throw new Error(`set-password failed: ${json.msg ?? res.status}`);
    }
  }

  private async postJson(path: string, cookie: string, payload: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({ status: 'error' }))) as CasdoorResponse;
    if (json.status !== 'ok') {
      throw new Error(`casdoor ${path} failed: ${json.msg ?? res.status}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/casdoor-admin.service.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/onboarding/casdoor-admin.service.ts ui/packages/server/src/onboarding/casdoor-admin.service.spec.ts
git commit -m "feat(ui): casdoor admin takeover service (factory probe + claim)"
```

---

### Task 3: WgEasySecretStore (persist the rotated password)

**Files:**
- Create: `ui/packages/server/src/onboarding/wg-easy-secret.store.ts`
- Test: `ui/packages/server/src/onboarding/wg-easy-secret.store.spec.ts`

**Interfaces:**
- Consumes: `@kubernetes/client-node` (already a dependency, v1.4.0 — promise API returns objects directly, as `flux-status.service.ts` uses it).
- Produces: `WgEasySecretStore.load(): Promise<string | undefined>`, `save(password: string): Promise<void>` (throws when k8s is unavailable — callers must not rotate before a successful save).

- [ ] **Step 1: Write the failing tests**

`ui/packages/server/src/onboarding/wg-easy-secret.store.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WgEasySecretStore } from './wg-easy-secret.store';

function storeWith(overrides: Record<string, ReturnType<typeof vi.fn>>) {
  const store = new WgEasySecretStore();
  return { store, ...overrides };
}

describe('WgEasySecretStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  // NB: the store's k8s client is stubbed via `client` (private) — no k8s
  // env is touched, so these run anywhere.

  it('load returns the decoded password', async () => {
    const read = vi.fn().mockResolvedValue({ data: { password: Buffer.from('pw1').toString('base64') } });
    const { store } = storeWith({});
    vi.spyOn(store as any, 'client').mockReturnValue({ readNamespacedSecret: read });
    expect(await store.load()).toBe('pw1');
    expect(read).toHaveBeenCalledWith('marketplace-ui-wg-easy', 'marketplace-ui');
  });

  it('load swallows absence/RBAC denial as undefined', async () => {
    const { store } = storeWith({});
    vi.spyOn(store as any, 'client').mockReturnValue({
      readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 404 }),
    });
    expect(await store.load()).toBeUndefined();
    vi.spyOn(store as any, 'client').mockReturnValue(undefined);
    expect(await store.load()).toBeUndefined();
  });

  it('save replaces when the secret exists', async () => {
    const replace = vi.fn().mockResolvedValue({});
    const create = vi.fn();
    const { store } = storeWith({});
    vi.spyOn(store as any, 'client').mockReturnValue({ replaceNamespacedSecret: replace, createNamespacedSecret: create });
    await store.save('pw2');
    expect(replace).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('save creates after a 404 on replace', async () => {
    const replace = vi.fn().mockRejectedValue({ statusCode: 404 });
    const create = vi.fn().mockResolvedValue({});
    const { store } = storeWith({});
    vi.spyOn(store as any, 'client').mockReturnValue({ replaceNamespacedSecret: replace, createNamespacedSecret: create });
    await store.save('pw3');
    expect(create).toHaveBeenCalledWith('marketplace-ui', expect.objectContaining({
      stringData: { password: 'pw3' },
    }));
  });

  it('save throws when k8s is unavailable (callers must not rotate first)', async () => {
    const { store } = storeWith({});
    vi.spyOn(store as any, 'client').mockReturnValue(undefined);
    await expect(store.save('pw4')).rejects.toThrow('k8s config unavailable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/wg-easy-secret.store.ts.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`ui/packages/server/src/onboarding/wg-easy-secret.store.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { CoreV1Api, KubeConfig, V1Secret } from '@kubernetes/client-node';

const SECRET_NAME = 'marketplace-ui-wg-easy';
const NAMESPACE = 'marketplace-ui';

/**
 * Persists the rotated wg-easy admin password to a Secret in our own
 * namespace (same model as marketplace-ui-session: not in Git, so Flux never
 * prunes it; written at runtime by the server, readable across pod restarts
 * so a future Devices panel inherits its credential). RBAC: Role in
 * apps/marketplace-ui/base/serviceaccount.yaml.
 */
@Injectable()
export class WgEasySecretStore {
  private readonly logger = new Logger(WgEasySecretStore.name);
  private core?: CoreV1Api;

  private client(): CoreV1Api | undefined {
    if (this.core) return this.core;
    try {
      const kc = new KubeConfig();
      kc.loadFromDefault(); // in-cluster when KUBERNETES_SERVICE_HOST is set, kubeconfig otherwise
      this.core = kc.makeApiClient(CoreV1Api);
      return this.core;
    } catch (err) {
      this.logger.debug(`k8s config unavailable: ${String(err)}`);
      return undefined;
    }
  }

  async load(): Promise<string | undefined> {
    const core = this.client();
    if (!core) return undefined;
    try {
      const secret: V1Secret = await core.readNamespacedSecret(SECRET_NAME, NAMESPACE);
      const encoded = secret.data?.['password'];
      return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined;
    } catch {
      return undefined; // absent or RBAC-denied — both mean "not rotated yet"
    }
  }

  async save(password: string): Promise<void> {
    const core = this.client();
    if (!core) throw new Error('k8s config unavailable');
    const secret: V1Secret = {
      metadata: {
        name: SECRET_NAME,
        namespace: NAMESPACE,
        labels: { 'app.kubernetes.io/name': 'marketplace-ui' },
      },
      stringData: { password },
    };
    try {
      await core.replaceNamespacedSecret(SECRET_NAME, NAMESPACE, secret);
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode === 404) {
        await core.createNamespacedSecret(NAMESPACE, secret);
      } else {
        throw err;
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/wg-easy-secret.store.ts.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/onboarding/wg-easy-secret.store.ts ui/packages/server/src/onboarding/wg-easy-secret.store.ts.spec.ts
git commit -m "feat(ui): secret store for the rotated wg-easy credential"
```

---

### Task 4: WgEasyService (Basic-auth client + factory rotation)

**Files:**
- Create: `ui/packages/server/src/onboarding/wg-easy.service.ts`
- Test: `ui/packages/server/src/onboarding/wg-easy.service.spec.ts`

**Interfaces:**
- Consumes: `WgEasySecretStore` (Task 3), `WgPeer` (Task 1).
- Produces: `WgEasyService.adoptPassword(password: string): Promise<void>` (claim-time: persist then rotate best-effort), `ensurePassword(preferred?: string): Promise<string>`, `listClients(): Promise<WgPeer[]>`, `createClient(name: string): Promise<{clientId: string}>`, `clientConfiguration(id): Promise<string>`, `clientQrSvg(id): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

`ui/packages/server/src/onboarding/wg-easy.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { WgEasyService } from './wg-easy.service';
import type { WgEasySecretStore } from './wg-easy-secret.store';

function makeService(store: Partial<WgEasySecretStore>) {
  return new WgEasyService(store as WgEasySecretStore);
}

function ok(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('WgEasyService', () => {
  beforeEach(() => {
    process.env.WGEASY_BASE_URL = 'http://wg-easy.test';
  });
  afterEach(() => vi.restoreAllMocks());

  it('uses the persisted password when it still authenticates', async () => {
    const load = vi.fn().mockResolvedValue('rotated-pw');
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(ok([]));
    const svc = makeService({ load });
    expect(await svc.ensurePassword()).toBe('rotated-pw');
    expect(fetchMock.mock.calls[0][0]).toBe('http://wg-easy.test/api/client');
  });

  it('adoptPassword: persists FIRST, then rotates the factory password to the user-chosen one', async () => {
    const readFileSync = await import('node:fs');
    vi.spyOn(readFileSync, 'readFileSync').mockReturnValue('ChangeMeOnFirstLogin!\n');
    const load = vi.fn().mockResolvedValue(undefined);
    const save = vi.fn().mockResolvedValue(undefined);
    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers['authorization'], body: typeof init?.body === 'string' ? init.body : undefined });
      const u = String(url);
      if (u.endsWith('/api/me/password')) return ok({ success: true });
      return ok([]); // /api/client probe/list
    });
    const svc = makeService({ load, save });
    await svc.adoptPassword('chosen-pw1');
    expect(save).toHaveBeenCalledWith('chosen-pw1');
    const rotate = calls.find((c) => c.url.endsWith('/api/me/password'))!;
    // rotated FROM the factory credential TO the chosen password
    expect(rotate.auth).toContain(Buffer.from('admin:ChangeMeOnFirstLogin!').toString('base64'));
    expect(JSON.parse(rotate.body!)).toMatchObject({
      currentPassword: 'ChangeMeOnFirstLogin!',
      newPassword: 'chosen-pw1',
    });
  });

  it('adoptPassword survives a wg-easy outage: persisted, rotation deferred', async () => {
    const readFileSync = await import('node:fs');
    vi.spyOn(readFileSync, 'readFileSync').mockReturnValue('ChangeMeOnFirstLogin!\n');
    const save = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = makeService({ load: vi.fn().mockResolvedValue(undefined), save });
    await expect(svc.adoptPassword('chosen-pw1')).resolves.toBeUndefined();
    expect(save).toHaveBeenCalledWith('chosen-pw1');
  });

  it('ensurePassword lazily rotates to the persisted value (wg was down at claim)', async () => {
    const readFileSync = await import('node:fs');
    vi.spyOn(readFileSync, 'readFileSync').mockReturnValue('ChangeMeOnFirstLogin!\n');
    const rotations: string[] = [];
    const chosenB64 = Buffer.from('admin:chosen-pw1').toString('base64');
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (u.endsWith('/api/me/password')) {
        rotations.push(String(init!.body));
        return ok({ success: true });
      }
      // the chosen password is NOT yet active on wg-easy — only factory authenticates
      if ((headers['authorization'] ?? '').includes(chosenB64)) {
        return new Response('', { status: 401 });
      }
      return ok([]);
    });
    const svc = makeService({ load: vi.fn().mockResolvedValue('chosen-pw1'), save: vi.fn() });
    expect(await svc.ensurePassword()).toBe('chosen-pw1');
    expect(rotations).toHaveLength(1);
    expect(JSON.parse(rotations[0]!)).toMatchObject({
      currentPassword: 'ChangeMeOnFirstLogin!',
      newPassword: 'chosen-pw1',
    });
  });

  it('throws when no credential works (already rotated elsewhere + factory dead)', async () => {
    const readFileSync = await import('node:fs');
    vi.spyOn(readFileSync, 'readFileSync').mockReturnValue('ChangeMeOnFirstLogin!\n');
    const load = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await expect(makeService({ load }).ensurePassword()).rejects.toThrow(ServiceUnavailableException);
  });

  it('createClient posts {name, expiresAt: null} and returns clientId', async () => {
    const svc = makeService({ load: vi.fn().mockResolvedValue('pw') });
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok([])) // probe
      .mockResolvedValueOnce(ok({ success: true, clientId: 'c1' }));
    expect(await svc.createClient('phone')).toEqual({ clientId: 'c1' });
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe('http://wg-easy.test/api/client');
    expect(JSON.parse(String(init!.body))).toEqual({ name: 'phone', expiresAt: null });
  });

  it('listClients maps peers with latestHandshakeAt', async () => {
    const svc = makeService({ load: vi.fn().mockResolvedValue('pw') });
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([
        { clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: '2026-09-05T10:00:00Z' },
        { clientId: 'b', name: 'laptop', enabled: false },
      ]));
    const peers = await svc.listClients();
    expect(peers[1]).toMatchObject({ clientId: 'b', latestHandshakeAt: null });
  });

  it('clientConfiguration / clientQrSvg passthrough as text', async () => {
    const svc = makeService({ load: vi.fn().mockResolvedValue('pw') });
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok('[Interface]\n…', 200))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok('<svg/>', 200));
    expect(await svc.clientConfiguration('c1')).toContain('[Interface]');
    expect(await svc.clientQrSvg('c1')).toContain('<svg');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/wg-easy.service.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`ui/packages/server/src/onboarding/wg-easy.service.ts`:

```ts
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WgPeer } from '@librepod/shared';
import { WgEasySecretStore } from './wg-easy-secret.store';

const FACTORY_PASSWORD_FILE = process.env.WGEASY_PASSWORD_FILE ?? '/etc/wg-easy/INIT_PASSWORD';

/**
 * wg-easy v15 API client. Every route accepts
 * `Authorization: Basic admin:<password>` (src/server/utils/session.ts), so
 * this is stateless. wg-easy has no SSO, so the device uses ONE password:
 * at claim time `adoptPassword(chosen)` rotates the factory password
 * (INIT_PASSWORD from the reflected wg-easy-admin Secret) to the same
 * password the user chose for Casdoor, persisting it via WgEasySecretStore.
 * Order matters: persist BEFORE rotating, so a failed persist never
 * destroys the factory credential; a wg-easy outage during claim defers
 * the rotation (the lazy ensurePassword() picks the value up from the
 * Secret once wg-easy is reachable again).
 */
@Injectable()
export class WgEasyService {
  private readonly logger = new Logger(WgEasyService.name);
  private readonly baseUrl = (process.env.WGEASY_BASE_URL ?? '').replace(/\/$/, '');
  private password?: string;

  constructor(private readonly store: WgEasySecretStore) {}

  /** Claim-time: persist the chosen password, then rotate best-effort.
   * Throws only when the Secret cannot be persisted (nothing has been
   * rotated yet in that case, so the caller can safely defer). */
  async adoptPassword(password: string): Promise<void> {
    await this.store.save(password);
    try {
      await this.ensurePassword(password);
    } catch (err) {
      this.logger.warn(`wg-easy password adoption deferred: ${String(err)}`);
    }
  }

  /** A working wg-easy admin password. `preferred` (the user's chosen
   * password) wins while the factory credential still works; otherwise the
   * persisted value; random is the never-expected fallback (Secret wiped
   * mid-tour) that at least closes the factory window. */
  async ensurePassword(preferred?: string): Promise<string> {
    if (this.password) return this.password;
    const persisted = await this.store.load();
    const candidate = preferred ?? persisted;
    if (candidate && (await this.tryAuth(candidate))) {
      this.password = candidate;
      return candidate;
    }
    const factory = this.factoryPassword();
    if (factory && (await this.tryAuth(factory))) {
      const target = candidate ?? crypto.randomBytes(24).toString('base64url');
      await this.store.save(target); // persist before rotating (see class comment)
      const res = await fetch(`${this.baseUrl}/api/me/password`, {
        method: 'POST',
        headers: this.authHeaders(factory),
        body: JSON.stringify({ currentPassword: factory, newPassword: target }),
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(`wg-easy password rotation failed: ${res.status}`);
      }
      this.logger.log('adopted the chosen password as the wg-easy admin password');
      this.password = target;
      return target;
    }
    throw new ServiceUnavailableException('wg-easy admin credential unavailable');
  }

  private factoryPassword(): string | undefined {
    try {
      return readFileSync(FACTORY_PASSWORD_FILE, 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private authHeaders(password: string): Record<string, string> {
    return {
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
      'content-type': 'application/json',
    };
  }

  private async tryAuth(password: string): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/client`, { headers: this.authHeaders(password) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listClients(): Promise<WgPeer[]> {
    const res = await this.request('/api/client');
    const raw = (await res.json()) as Array<Record<string, unknown>>;
    return raw.map((c) => ({
      clientId: String(c.clientId),
      name: String(c.name ?? ''),
      enabled: Boolean(c.enabled),
      latestHandshakeAt: (c.latestHandshakeAt as string | undefined) ?? null,
    }));
  }

  async createClient(name: string): Promise<{ clientId: string }> {
    const res = await this.request('/api/client', {
      method: 'POST',
      body: JSON.stringify({ name, expiresAt: null }),
    });
    return (await res.json()) as { clientId: string };
  }

  async clientConfiguration(clientId: string): Promise<string> {
    const res = await this.request(`/api/client/${clientId}/configuration`);
    return res.text();
  }

  async clientQrSvg(clientId: string): Promise<string> {
    const res = await this.request(`/api/client/${clientId}/qrcode.svg`);
    return res.text();
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const password = await this.ensurePassword();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.authHeaders(password),
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(`wg-easy ${path} failed: ${res.status}`);
    }
    return res;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/wg-easy.service.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/onboarding/wg-easy.service.ts ui/packages/server/src/onboarding/wg-easy.service.spec.ts
git commit -m "feat(ui): wg-easy client with factory password rotation"
```

---

### Task 5: OnboardingGuard + BootstrapController (status / ca / claim)

**Files:**
- Create: `ui/packages/server/src/onboarding/onboarding.guard.ts`
- Create: `ui/packages/server/src/onboarding/bootstrap.controller.ts`
- Test: `ui/packages/server/src/onboarding/bootstrap.controller.spec.ts`

**Interfaces:**
- Consumes: `CasdoorAdminService` (Task 2), `WgEasyService` (Task 4), `SessionService` (auth module, exported).
- Produces: `GET /api/bootstrap/status` → `OnboardingStatus` (mints `mp_onboarding` while unclaimed); `GET /api/bootstrap/ca` → certificate file; `POST /api/bootstrap/claim` `{password}` → `{ok: true}`; `OnboardingGuard` verifying cookie `mp_onboarding` with `sub === 'onboarding'`.

- [ ] **Step 1: Write the failing tests**

`ui/packages/server/src/onboarding/bootstrap.controller.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { BootstrapController } from './bootstrap.controller';
import type { CasdoorAdminService } from './casdoor-admin.service';
import type { WgEasyService } from './wg-easy.service';
import type { SessionService } from '../auth/session.service';
import type { WgPeer } from '@librepod/shared';

function makeController(overrides: {
  probe?: ReturnType<typeof vi.fn>;
  claim?: ReturnType<typeof vi.fn>;
  wg?: Partial<WgEasyService>;
}) {
  const casdoorAdmin = {
    probeFactoryLogin: overrides.probe ?? vi.fn(),
    claim: overrides.claim ?? vi.fn(),
  } as unknown as CasdoorAdminService;
  const wgEasy = { listClients: vi.fn(), ensurePassword: vi.fn(), ...(overrides.wg ?? {}) } as unknown as WgEasyService;
  const session = {
    sign: vi.fn().mockReturnValue('signed-token'),
    verify: vi.fn(),
    ttlSeconds: 8 * 60 * 60,
    cookieName: 'mp_session',
  } as unknown as SessionService;
  const controller = new BootstrapController(casdoorAdmin, wgEasy, session, new ConfigService({ BASE_DOMAIN: 'libre.pod' }));
  return { controller, casdoorAdmin, wgEasy, session };
}

function fakeRes() {
  const cookies: Record<string, unknown> = {};
  return {
    cookies,
    cookie: vi.fn((n: string, v: unknown, _o: unknown) => { cookies[n] = v; }),
    setHeader: vi.fn(),
    send: vi.fn(),
  } as unknown as Response & { cookies: Record<string, unknown> };
}

function reqWithHost(host: string) {
  return { headers: { 'x-forwarded-host': host } } as unknown as Request;
}

describe('BootstrapController.status', () => {
  beforeEach(() => { delete process.env.BOOTSTRAP_MODE_OVERRIDE; });

  it('waiting: casdoor unreachable, no wg probing, arrival ip', async () => {
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('unreachable') });
    const res = fakeRes();
    const status = await controller.status(reqWithHost('192.168.2.10'), res);
    expect(status).toMatchObject({ mode: 'waiting', arrival: 'ip', casdoorUp: false, adminClaimed: null });
  });

  it('onboarding: factory login ok, mints the onboarding cookie', async () => {
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('ok') });
    const res = fakeRes();
    const status = await controller.status(reqWithHost('192.168.2.10'), res);
    expect(status).toMatchObject({ mode: 'onboarding', adminClaimed: false });
    expect(res.cookie).toHaveBeenCalledWith('mp_onboarding', 'signed-token', expect.anything());
  });

  it('ready (claimed): does NOT mint the cookie, queries wg peer state', async () => {
    const peers: WgPeer[] = [
      { clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: '2026-09-05T10:00:00Z' },
      { clientId: 'b', name: 'lap', enabled: true, latestHandshakeAt: '2026-09-05T09:00:00Z' },
    ];
    const { controller, wgEasy } = makeController({
      probe: vi.fn().mockResolvedValue('rejected'),
      wg: { listClients: vi.fn().mockResolvedValue(peers) },
    });
    const res = fakeRes();
    const status = await controller.status(reqWithHost('libre.pod'), res);
    expect(status).toMatchObject({
      mode: 'ready', arrival: 'domain', adminClaimed: true, peerCount: 2, wgEasyUp: true,
      lastHandshakeAt: '2026-09-05T10:00:00Z',
    });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(wgEasy.listClients).toHaveBeenCalled();
  });

  it('caches the rejected probe (no login storm after claim)', async () => {
    const probe = vi.fn().mockResolvedValue('rejected');
    const { controller } = makeController({ probe });
    await controller.status(reqWithHost('libre.pod'), fakeRes());
    await controller.status(reqWithHost('libre.pod'), fakeRes());
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('BOOTSTRAP_MODE_OVERRIDE forces the mode (test seam)', async () => {
    process.env.BOOTSTRAP_MODE_OVERRIDE = 'onboarding';
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('rejected') });
    const status = await controller.status(reqWithHost('libre.pod'), fakeRes());
    expect(status.mode).toBe('onboarding');
  });
});

describe('BootstrapController.claim', () => {
  it('takes over, adopts the same password on wg-easy, mints the cookie', async () => {
    const claim = vi.fn().mockResolvedValue(undefined);
    const adoptPassword = vi.fn().mockResolvedValue(undefined);
    const { controller } = makeController({ probe: vi.fn().mockResolvedValue('ok'), claim, wg: { adoptPassword } });
    const res = fakeRes();
    await controller.claim({ password: 'longenough1' }, res);
    expect(claim).toHaveBeenCalledWith({ password: 'longenough1' });
    expect(adoptPassword).toHaveBeenCalledWith('longenough1');
    expect(res.cookie).toHaveBeenCalled();
  });

  it('claim survives a failed password adoption (deferred to first wg call)', async () => {
    const { controller } = makeController({
      probe: vi.fn().mockResolvedValue('ok'),
      claim: vi.fn().mockResolvedValue(undefined),
      wg: { adoptPassword: vi.fn().mockRejectedValue(new Error('no k8s')) },
    });
    const res = fakeRes();
    await expect(controller.claim({ password: 'longenough1' }, res)).resolves.toMatchObject({ ok: true });
  });

  it('rejects weak input before touching casdoor', async () => {
    const { controller, casdoorAdmin } = makeController({});
    await expect(controller.claim({ password: 'short' }, fakeRes())).rejects.toThrow(BadRequestException);
    await expect(controller.claim({ password: 'has space1' }, fakeRes())).rejects.toThrow(BadRequestException);
    expect(casdoorAdmin.claim).not.toHaveBeenCalled();
  });
});

describe('BootstrapController.ca', () => {
  it('streams the mounted root CA with download headers', async () => {
    const fs = await import('node:fs');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from('-----BEGIN CERTIFICATE-----\n…'));
    process.env.ROOT_CA_PATH = '/tmp/root.crt';
    const { controller } = makeController({});
    const res = fakeRes();
    await controller.ca(res);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/x-x509-ca-cert');
    expect(res.send).toHaveBeenCalled();
  });

  it('404s when the CA is not mounted', async () => {
    const fs = await import('node:fs');
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    process.env.ROOT_CA_PATH = '/tmp/root.crt';
    const { controller } = makeController({});
    await expect(controller.ca(fakeRes())).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/bootstrap.controller.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the guard**

`ui/packages/server/src/onboarding/onboarding.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../auth/session.service';

export const ONBOARDING_COOKIE = 'mp_onboarding';

/**
 * Gates the wizard's WireGuard endpoints. The cookie is minted only while
 * the factory window is open, so it proves "present before the door closed"
 * and expires with the tour — post-graduation, nobody can mint a new one.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(private readonly session: SessionService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ cookies?: Record<string, string> }>();
    const claims = this.session.verify(req.cookies?.[ONBOARDING_COOKIE]);
    if (!claims || claims.sub !== 'onboarding') {
      throw new UnauthorizedException();
    }
    return true;
  }
}
```

- [ ] **Step 4: Write the controller**

`ui/packages/server/src/onboarding/bootstrap.controller.ts`:

```ts
import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import type { OnboardingStatus } from '@librepod/shared';
import { CasdoorAdminService } from './casdoor-admin.service';
import { WgEasyService } from './wg-easy.service';
import { SessionService } from '../auth/session.service';
import { ONBOARDING_COOKIE } from './onboarding.guard';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function arrivalOf(req: Request): 'ip' | 'domain' {
  const xfh = req.headers['x-forwarded-host'];
  const host = (Array.isArray(xfh) ? xfh[0] : xfh) ?? req.headers.host ?? '';
  return IPV4.test(host.split(':')[0]) ? 'ip' : 'domain';
}

@Controller('bootstrap')
export class BootstrapController {
  private readonly logger = new Logger(BootstrapController.name);
  /** Set once the factory login is rejected (or this process claimed) so
   * ready clusters stop hammering /api/login on every status poll. */
  private claimedCached = false;

  constructor(
    private readonly casdoorAdmin: CasdoorAdminService,
    private readonly wgEasy: WgEasyService,
    private readonly session: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Get('status')
  async status(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<OnboardingStatus> {
    const probe = this.claimedCached ? 'rejected' : await this.casdoorAdmin.probeFactoryLogin();
    if (probe === 'rejected') this.claimedCached = true;

    const status: OnboardingStatus = {
      mode: probe === 'unreachable' ? 'waiting' : probe === 'ok' ? 'onboarding' : 'ready',
      arrival: arrivalOf(req),
      baseDomain: this.config.get<string>('BASE_DOMAIN', 'libre.pod'),
      casdoorUp: probe !== 'unreachable',
      wgEasyUp: false,
      adminClaimed: probe === 'rejected' ? true : probe === 'ok' ? false : null,
      peerCount: null,
      lastHandshakeAt: null,
    };
    const override = process.env.BOOTSTRAP_MODE_OVERRIDE as OnboardingStatus['mode'] | undefined;
    if (override) status.mode = override;

    // Tour telemetry only — never queried pre-claim (rotation must not be a
    // side effect of a GET poll; it happens in claim or the wg endpoints).
    if (status.adminClaimed) {
      try {
        const peers = await this.wgEasy.listClients();
        status.wgEasyUp = true;
        status.peerCount = peers.length;
        status.lastHandshakeAt =
          peers
            .map((p) => p.latestHandshakeAt)
            .filter((t): t is string => Boolean(t))
            .sort()
            .at(-1) ?? null;
      } catch {
        status.wgEasyUp = false;
      }
    }

    if (status.mode === 'onboarding') {
      this.mintOnboardingCookie(res);
    }
    return status;
  }

  @Post('claim')
  async claim(
    body: { password?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const password = body.password ?? '';
    if (password.length < 8 || /\s/.test(password)) {
      throw new BadRequestException('password must be at least 8 characters without spaces');
    }
    await this.casdoorAdmin.claim({ password });
    this.claimedCached = true;
    // One password for the whole device: adopt it on wg-easy too. Failure is
    // non-fatal — adoptPassword persisted-first, so the lazy ensurePassword()
    // retries on the next wg call.
    try {
      await this.wgEasy.adoptPassword(password);
    } catch (err) {
      this.logger.warn(`wg-easy password adoption deferred: ${String(err)}`);
    }
    this.mintOnboardingCookie(res);
    return { ok: true };
  }

  @Get('ca')
  ca(@Res() res: Response): void {
    const path = process.env.ROOT_CA_PATH;
    if (!path || !existsSync(path)) {
      throw new NotFoundException('root CA not available');
    }
    // Public by design — the same cert root-ca.<domain> serves unauthenticated.
    res.setHeader('content-type', 'application/x-x509-ca-cert');
    res.setHeader('content-disposition', 'attachment; filename="librepod-root-ca.crt"');
    res.send(readFileSync(path));
  }

  /** httpOnly, NOT Secure: the wizard IS the http://<ip> experience, and a
   * Secure cookie would be silently dropped by the browser there. The token
   * only proves presence before the factory window closed; it grants nothing
   * the tour does not already grant, and expires with it. */
  private mintOnboardingCookie(res: Response): void {
    const token = this.session.sign({ sub: 'onboarding', name: 'onboarding', email: '' });
    res.cookie(ONBOARDING_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: this.session.ttlSeconds * 1000,
    });
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/bootstrap.controller.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/packages/server/src/onboarding/onboarding.guard.ts ui/packages/server/src/onboarding/bootstrap.controller.ts ui/packages/server/src/onboarding/bootstrap.controller.spec.ts
git commit -m "feat(ui): bootstrap status/claim/ca endpoints with onboarding cookie"
```

---

### Task 6: WireguardController (peer lifecycle passthrough)

**Files:**
- Create: `ui/packages/server/src/onboarding/wireguard.controller.ts`
- Test: `ui/packages/server/src/onboarding/wireguard.controller.spec.ts`

**Interfaces:**
- Consumes: `WgEasyService` (Task 4), `OnboardingGuard` (Task 5).
- Produces: `GET /api/bootstrap/wireguard` → `{peers: WgPeer[]}`; `POST /api/bootstrap/wireguard/peer` `{name}` → `{clientId, name}`; `GET /api/bootstrap/wireguard/clients/:id/configuration` → text; `GET /api/bootstrap/wireguard/clients/:id/qrcode.svg` → svg. All behind the onboarding cookie.

- [ ] **Step 1: Write the failing tests**

`ui/packages/server/src/onboarding/wireguard.controller.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { WireguardController } from './wireguard.controller';
import type { WgEasyService } from './wg-easy.service';

function makeController(wg: Partial<WgEasyService>) {
  return new WireguardController({ listClients: vi.fn(), createClient: vi.fn(), ...(wg as object) } as unknown as WgEasyService);
}

function fakeRes() {
  return { setHeader: vi.fn(), send: vi.fn() } as unknown as Response;
}

describe('WireguardController', () => {
  it('lists peers', async () => {
    const peers = [{ clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: null }];
    const ctrl = makeController({ listClients: vi.fn().mockResolvedValue(peers) });
    expect(await ctrl.list()).toEqual({ peers });
  });

  it('creates a peer, defaulting the device name', async () => {
    const createClient = vi.fn().mockResolvedValue({ clientId: 'c1' });
    const ctrl = makeController({ createClient });
    expect(await ctrl.createPeer({ name: '  phone ' })).toEqual({ clientId: 'c1', name: 'phone' });
    expect(createClient).toHaveBeenCalledWith('phone');
    expect(await ctrl.createPeer({})).toEqual({ clientId: 'c1', name: 'my-device' });
  });

  it('rejects dangerous names and ids', async () => {
    const ctrl = makeController({});
    await expect(ctrl.createPeer({ name: 'x'.repeat(80) })).rejects.toThrow(BadRequestException);
    await expect(ctrl.createPeer({ name: 'a/b' })).rejects.toThrow(BadRequestException);
    await expect(ctrl.configuration('../etc', fakeRes())).rejects.toThrow(BadRequestException);
  });

  it('streams the configuration with an attachment header', async () => {
    const ctrl = makeController({ clientConfiguration: vi.fn().mockResolvedValue('[Interface]') });
    const res = fakeRes();
    await ctrl.configuration('c1', res);
    expect(res.setHeader).toHaveBeenCalledWith('content-disposition', 'attachment; filename="librepod-c1.conf"');
    expect(res.send).toHaveBeenCalledWith('[Interface]');
  });

  it('streams the QR svg', async () => {
    const ctrl = makeController({ clientQrSvg: vi.fn().mockResolvedValue('<svg/>') });
    const res = fakeRes();
    await ctrl.qrcode('c1', res);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'image/svg+xml');
    expect(res.send).toHaveBeenCalledWith('<svg/>');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && npm test --workspace=packages/server -- src/onboarding/wireguard.controller.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

`ui/packages/server/src/onboarding/wireguard.controller.ts`:

```ts
import { BadRequestException, Controller, Get, Param, Post, Body, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { WgPeer } from '@librepod/shared';
import { WgEasyService } from './wg-easy.service';
import { OnboardingGuard } from './onboarding.guard';

// ids are wg-easy clientIds used in proxy URLs — keep them path-safe
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

@Controller('bootstrap/wireguard')
@UseGuards(OnboardingGuard)
export class WireguardController {
  constructor(private readonly wgEasy: WgEasyService) {}

  @Get()
  async list(): Promise<{ peers: WgPeer[] }> {
    return { peers: await this.wgEasy.listClients() };
  }

  @Post('peer')
  async createPeer(@Body() body: { name?: string }): Promise<{ clientId: string; name: string }> {
    const name = (body.name ?? '').trim() || 'my-device';
    if (name.length > 64 || /[/\\?%*:|"<>]/.test(name)) {
      throw new BadRequestException('invalid device name');
    }
    const { clientId } = await this.wgEasy.createClient(name);
    return { clientId, name };
  }

  @Get('clients/:id/configuration')
  async configuration(@Param('id') id: string, @Res() res: Response): Promise<void> {
    if (!SAFE_ID.test(id)) throw new BadRequestException('invalid client id');
    const config = await this.wgEasy.clientConfiguration(id);
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="librepod-${id}.conf"`);
    res.send(config);
  }

  @Get('clients/:id/qrcode.svg')
  async qrcode(@Param('id') id: string, @Res() res: Response): Promise<void> {
    if (!SAFE_ID.test(id)) throw new BadRequestException('invalid client id');
    const svg = await this.wgEasy.clientQrSvg(id);
    res.setHeader('content-type', 'image/svg+xml');
    res.send(svg);
  }
}
```

- [ ] **Step 4: Run tests + the whole server suite**

Run: `cd ui && npm test --workspace=packages/server`
Expected: PASS (existing suites + all new onboarding suites).

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/onboarding/wireguard.controller.ts ui/packages/server/src/onboarding/wireguard.controller.spec.ts
git commit -m "feat(ui): wizard wireguard proxy endpoints behind onboarding cookie"
```

---

### Task 7: Client — useBootstrapStatus hook + RootGate + pre-auth screens

**Files:**
- Create: `ui/packages/client/src/hooks/useBootstrapStatus.ts`
- Create: `ui/packages/client/src/components/RootGate.tsx`
- Create: `ui/packages/client/src/components/PreAuthScreens.tsx`
- Modify: `ui/packages/client/src/router.tsx`
- Test: `ui/packages/client/src/components/PreAuthScreens.test.tsx`

**Interfaces:**
- Consumes: `OnboardingStatus` (Task 1), `FullScreenSpinner`.
- Produces: `useBootstrapStatus()` (TanStack query, key `["bootstrapStatus"]`, 4s polling while not `ready`-on-domain); `RootGate` renders `WakingScreen` | `OnboardingPage` | `UseDomainScreen` | `<Outlet/>`; `WakingScreen` / `UseDomainScreen` exported for tests and reuse.

- [ ] **Step 1: Write the hook**

`ui/packages/client/src/hooks/useBootstrapStatus.ts`:

```ts
import { useQuery } from "@tanstack/react-query"
import type { OnboardingStatus } from "@librepod/shared"

/**
 * The pre-auth heartbeat. Plain fetch on purpose — apiFetch's 401 handler
 * redirects to /api/auth/login, which on a fresh cluster is a redirect into
 * an unresolvable host. That redirect is the exact bug onboarding fixes.
 */
export function useBootstrapStatus() {
  return useQuery<OnboardingStatus>({
    queryKey: ["bootstrapStatus"],
    queryFn: async () => {
      const res = await fetch("/api/bootstrap/status")
      if (!res.ok) throw new Error(`bootstrap status ${res.status}`)
      return res.json()
    },
    // Keep polling through the tour: mode "ready" + IP arrival still drives
    // the wizard (peer + handshake telemetry lives in this status).
    refetchInterval: (query) =>
      query.state.data?.mode === "ready" && query.state.data.arrival === "domain" ? false : 4000,
  })
}
```

- [ ] **Step 2: Write the pre-auth screens**

`ui/packages/client/src/components/PreAuthScreens.tsx`:

```tsx
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import type { OnboardingStatus } from "@librepod/shared"
import { Button } from "@/components/ui/button"

/** Fresh boot: system apps are still converging. Turns dead minutes into a
 *  progress story instead of a spinner with no explanation. */
export function WakingScreen({ status }: { status?: OnboardingStatus }) {
  const casdoorUp = status?.casdoorUp
  return (
    <Centered>
      <h1 className="text-2xl font-semibold">Your LibrePod is waking up</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        System services are starting for the first time. This usually takes a few minutes —
        this page updates itself.
      </p>
      <ul className="mt-6 space-y-2 text-sm" aria-label="service status">
        <ServiceLight label="Identity (single sign-on)" up={casdoorUp} />
        <ServiceLight label="App catalog" up={true} />
      </ul>
      <p className="mt-6 text-xs text-muted-foreground">
        You are on the raw device address ({status ? "http://" + location.host : "…"}). That is normal for a
        brand-new device — by the end of setup it will have a name.
      </p>
    </Centered>
  )
}

/** Post-graduation arrival over the raw IP: the app lives on the domain now. */
export function UseDomainScreen({ status }: { status: OnboardingStatus }) {
  return (
    <Centered>
      <p className="text-sm text-muted-foreground">Your device is set up and has a name:</p>
      <h1 className="mt-2 font-mono text-2xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Connect your WireGuard tunnel (it also makes this name resolve), then open
        the address above. This raw address keeps working, but without your tunnel
        it cannot sign you in.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <a href={`https://${status.baseDomain}`}>Open {status.baseDomain}</a>
        </Button>
        <Button asChild variant="outline">
          <Link to="/onboarding">Show my connection keys</Link>
        </Button>
        <Button asChild variant="ghost">
          <a href="/api/bootstrap/ca" download>Download root CA</a>
        </Button>
      </div>
    </Centered>
  )
}

function ServiceLight({ label, up }: { label: string; up: boolean | undefined }) {
  return (
    <li className="flex items-center gap-2">
      <span
        aria-hidden
        className={
          "inline-block size-2 rounded-full " +
          (up === undefined ? "animate-pulse bg-muted-foreground/40" : up ? "bg-emerald-500" : "bg-muted-foreground/40")
        }
      />
      <span className="text-muted-foreground">{label}</span>
      {up === false && <span className="text-xs text-muted-foreground/60">starting…</span>}
    </li>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: Write RootGate**

`ui/packages/client/src/components/RootGate.tsx`:

```tsx
import { Outlet } from "react-router-dom"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import { FullScreenSpinner } from "@/components/FullScreenSpinner"
import { UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage"

/**
 * The mode router that sits ABOVE AuthGate. One status object decides the
 * whole pre-auth experience:
 *   waiting                → WakingScreen (services converging)
 *   onboarding             → the wizard
 *   ready + domain arrival → the normal authenticated app (Outlet)
 *   ready + ip arrival     → graduated but addressed by IP: UseDomainScreen
 *                            (until a handshake has been seen, the wizard
 *                            still owns the screen so setup can finish)
 */
export function RootGate() {
  const { data, isPending } = useBootstrapStatus()
  if (isPending) return <FullScreenSpinner />
  if (!data || data.mode === "waiting") return <WakingScreen status={data} />
  if (data.mode === "onboarding") return <OnboardingPage status={data} />
  if (data.arrival === "ip") {
    return data.lastHandshakeAt ? <UseDomainScreen status={data} /> : <OnboardingPage status={data} />
  }
  return <Outlet />
}
```

- [ ] **Step 4: Rewire the router**

`ui/packages/client/src/router.tsx` — replace the whole file:

```tsx
import { createBrowserRouter, Navigate } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { AuthGate } from "./components/AuthGate"
import { RootGate } from "./components/RootGate"
import { OnboardingPage } from "./pages/onboarding/OnboardingPage"
import { CatalogPage } from "./pages/CatalogPage"
import { AppDetailPage } from "./pages/AppDetailPage"
import { MyAppsPage } from "./pages/MyAppsPage"
import { NotFoundPage } from "./pages/NotFoundPage"

export const router = createBrowserRouter([
  {
    element: <RootGate />,
    children: [
      // Deep-linkable wizard (the UseDomainScreen "show my keys" affordance
      // and mid-tour reloads land here). Self-guards: outside onboarding it
      // redirects to /, where RootGate picks the right screen again.
      { path: "/onboarding", element: <OnboardingPage /> },
      {
        element: (
          <AuthGate>
            <AppShell />
          </AuthGate>
        ),
        children: [
          // The control plane is home: the daily action is opening an installed app.
          { path: "/", element: <MyAppsPage /> },
          { path: "/catalog", element: <CatalogPage /> },
          { path: "/apps/:name", element: <AppDetailPage /> },
          // Legacy alias — the installed grid used to live here.
          { path: "/my-apps", element: <Navigate to="/" replace /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
])
```

- [ ] **Step 5: Write the screen tests**

`ui/packages/client/src/components/PreAuthScreens.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"
import type { OnboardingStatus } from "@librepod/shared"

const ready: OnboardingStatus = {
  mode: "ready", arrival: "ip", baseDomain: "libre.pod",
  casdoorUp: true, wgEasyUp: true, adminClaimed: true, peerCount: 1,
  lastHandshakeAt: "2026-09-05T10:00:00Z",
}

describe("PreAuthScreens", () => {
  it("WakingScreen names the raw-IP situation as normal", () => {
    render(<MemoryRouter><WakingScreen /></MemoryRouter>)
    expect(screen.getByText(/waking up/i)).toBeVisible()
    expect(screen.getByText(/raw device address/i)).toBeVisible()
  })

  it("UseDomainScreen leads with the domain and links CA + keys", () => {
    render(<MemoryRouter><UseDomainScreen status={ready} /></MemoryRouter>)
    expect(screen.getByText("libre.pod")).toBeVisible()
    expect(screen.getByRole("link", { name: /download root ca/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    expect(screen.getByRole("link", { name: /connection keys/i })).toHaveAttribute("href", "/onboarding")
  })
})
```

- [ ] **Step 6: Run the screen tests**

Run: `cd ui && npm run test --workspace=packages/client -- src/components/PreAuthScreens.test.tsx`
Expected: PASS (this spec imports only the screens; the router imports the not-yet-existing `OnboardingPage` from Task 8, so the FULL client suite is deferred to Task 8 — do not run it yet).

- [ ] **Step 7: Commit**

```bash
git add ui/packages/client/src/hooks/useBootstrapStatus.ts ui/packages/client/src/components/RootGate.tsx ui/packages/client/src/components/PreAuthScreens.tsx ui/packages/client/src/components/PreAuthScreens.test.tsx ui/packages/client/src/router.tsx
git commit -m "feat(ui): root gate routes pre-auth traffic to waking/onboarding/domain screens"
```

---

### Task 8: Client — the OnboardingPage wizard

**Files:**
- Create: `ui/packages/client/src/pages/onboarding/OnboardingPage.tsx`
- Test: `ui/packages/client/src/pages/onboarding/OnboardingPage.test.tsx`

**Interfaces:**
- Consumes: `useBootstrapStatus()` (Task 7), `OnboardingStatus`/`WgPeer` (Task 1), `Button`, `Input`, `Card`, `Separator` from `@/components/ui`.
- Produces: default-export-free named `OnboardingPage({ status }: { status?: OnboardingStatus })` (prop optional — the `/onboarding` route renders it without one; it then uses the hook itself and self-guards by redirecting when `mode === 'ready' && arrival === 'domain'`).

- [ ] **Step 1: Write the implementation**

`ui/packages/client/src/pages/onboarding/OnboardingPage.tsx`:

```tsx
import { useEffect, useState, type FormEvent } from "react"
import { Navigate } from "react-router-dom"
import type { OnboardingStatus, WgPeer } from "@librepod/shared"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

/**
 * The first-run wizard. One hero — the owner — and it ends. Step truth is
 * derived from the live status on every render (cluster truth, no wizard
 * state), so reloads and pod restarts resume for free; the user can always
 * walk back to a completed step, and forward only through the gates.
 */
const STEPS = ["Welcome", "Claim", "Trust", "Connect", "Graduate"] as const

function deriveStep(s: OnboardingStatus): number {
  if (!s.adminClaimed) return 1
  if (s.peerCount === 0) return 2
  if (!s.lastHandshakeAt) return 3
  return 4
}

export function OnboardingPage({ status: propStatus }: { status?: OnboardingStatus }) {
  // Hooks first — the early returns below must never skip them.
  const query = useBootstrapStatus()
  const [userStep, setUserStep] = useState<number | null>(null)
  const status = propStatus ?? query.data
  if (!status) return null
  // Outside onboarding-with-a-reason the normal app owns the screen.
  if (status.mode === "ready" && status.arrival === "domain" && status.lastHandshakeAt) {
    return <Navigate to="/" replace />
  }
  const derived = deriveStep(status)
  const seenWelcome = localStorage.getItem("librepod-onboarding-welcome") === "1"
  const floor = derived === 1 && !seenWelcome ? 0 : derived
  const step = Math.max(floor, userStep ?? 0, 0)
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-lg">
        <StepRail current={step} />
        <Separator className="my-6" />
        {step === 0 && <WelcomeStep onBegin={() => { localStorage.setItem("librepod-onboarding-welcome", "1"); setUserStep(1) }} />}
        {step === 1 && <ClaimStep done={!!status.adminClaimed} baseDomain={status.baseDomain} onDone={() => { query.refetch(); setUserStep(2) }} />}
        {step === 2 && <TrustStep onDone={() => setUserStep(3)} />}
        {step === 3 && <ConnectStep status={status} onConnected={() => setUserStep(4)} />}
        {step === 4 && <GraduateStep status={status} />}
        {step > 0 && step < 4 && (
          <button className="mt-6 text-xs text-muted-foreground hover:text-foreground" onClick={() => setUserStep(step - 1)}>
            Back
          </button>
        )}
      </div>
    </div>
  )
}
```

Then the step components and the rail, in the same file:

```tsx
function StepRail({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="setup progress">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            aria-current={i === current ? "step" : undefined}
            className={
              "flex size-6 items-center justify-center rounded-full text-xs font-medium " +
              (i < current
                ? "bg-primary text-primary-foreground"
                : i === current
                  ? "border border-primary text-foreground"
                  : "border border-border text-muted-foreground/60")
            }
          >
            {i < current ? "✓" : i + 1}
          </span>
          <span className={"text-xs " + (i === current ? "text-foreground" : "text-muted-foreground/60")}>{label}</span>
        </li>
      ))}
    </ol>
  )
}

function WelcomeStep({ onBegin }: { onBegin: () => void }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Welcome to your LibrePod</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        You are on the raw device address — that is how every LibrePod starts. In about
        five minutes this setup gives your device a name, a single sign-in, and your own
        private network. No terminals involved.
      </p>
      <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
        <li>1 · Claim it — your admin sign-in</li>
        <li>2 · Trust it — install its root certificate</li>
        <li>3 · Connect — bring your phone or laptop onto the private network</li>
      </ul>
      <Button className="mt-6" onClick={onBegin}>Begin</Button>
    </section>
  )
}

function ClaimStep({ done, baseDomain, onDone }: { done: boolean; baseDomain: string; onDone: () => void }) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError("Passwords do not match")
      return
    }
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/bootstrap/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message ?? `claim failed (${res.status})`)
      }
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Claim your device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This device has a single administrator. The password you set here is the one
        and only sign-in for everything — the app store, single sign-on, and the VPN.
        Anyone on this network could claim it first; that window closes the moment you
        finish this step.
      </p>
      <p className="mt-4 font-mono text-sm">admin@{baseDomain}</p>
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <div>
          <label htmlFor="claim-password" className="text-sm font-medium">Password</label>
          <Input id="claim-password" type="password" className="mt-1" autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          <p className="mt-1 text-xs text-muted-foreground">At least 8 characters, no spaces.</p>
        </div>
        <div>
          <label htmlFor="claim-confirm" className="text-sm font-medium">Confirm password</label>
          <Input id="claim-confirm" type="password" className="mt-1" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || password.length < 8 || password !== confirm}>
          {busy ? "Claiming…" : "Claim this device"}
        </Button>
      </form>
      {done && (
        <p className="mt-4 text-sm text-muted-foreground">
          ✓ This device is already claimed — you are revisiting this step.
        </p>
      )}
    </section>
  )
}

function TrustStep({ onDone }: { onDone: () => void }) {
  const [installed, setInstalled] = useState(localStorage.getItem("librepod-onboarding-ca") === "1")
  return (
    <section>
      <h1 className="text-2xl font-semibold">Trust your device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your device issues its own certificates. Installing this root certificate on your
        phone and laptop now means every address ends in a clean padlock, starting with the
        next step.
      </p>
      <Button asChild className="mt-6">
        <a href="/api/bootstrap/ca" download>Download root certificate</a>
      </Button>
      <details className="mt-4 text-sm text-muted-foreground">
        <summary className="cursor-pointer text-foreground">How to install</summary>
        <ul className="mt-2 space-y-1">
          <li><b>iPhone/iPad:</b> Settings → Profile Downloaded → Install, then Settings → General → About → Certificate Trust Settings → enable full trust.</li>
          <li><b>Android:</b> Settings → Security → Install a certificate → CA certificate.</li>
          <li><b>macOS:</b> Keychain Access → System → Import, then double-click → Always Trust.</li>
          <li><b>Windows:</b> Double-click → Install Certificate → Local Machine → Trusted Root Certification Authorities.</li>
          <li><b>Ubuntu:</b> <code>sudo cp librepod-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</code></li>
        </ul>
      </details>
      <label className="mt-6 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={installed}
          onChange={(e) => { setInstalled(e.target.checked); localStorage.setItem("librepod-onboarding-ca", e.target.checked ? "1" : "0") }} />
        I installed the certificate
      </label>
      <Button className="mt-4" disabled={!installed} onClick={onDone}>Continue</Button>
    </section>
  )
}

function ConnectStep({ status, onConnected }: { status: OnboardingStatus; onConnected: () => void }) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const peersQuery = usePeers(status)
  const peers = peersQuery ?? []
  const connected = !!status.lastHandshakeAt

  async function createPeer() {
    setBusy(true); setError(null)
    try {
      const res = await fetch("/api/bootstrap/wireguard/peer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || "my-device" }),
      })
      if (!res.ok) throw new Error(`creating the key failed (${res.status})`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Connect your first device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        A private network between this device and yours. It also carries the name
        resolution that turns <span className="font-mono">*.{status.baseDomain}</span> into real addresses.
      </p>
      {peers.length === 0 ? (
        <div className="mt-6 space-y-3">
          <label htmlFor="peer-name" className="text-sm font-medium">Name this device (e.g. “phone”)</label>
          <Input id="peer-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="phone" />
          <Button onClick={createPeer} disabled={busy}>{busy ? "Creating…" : "Create connection key"}</Button>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      ) : (
        <PeerPanel peers={peers} />
      )}
      <div className="mt-6 rounded-lg border border-border p-4">
        <p className="flex items-center gap-2 text-sm">
          <span aria-hidden className={"inline-block size-2 rounded-full " + (connected ? "bg-emerald-500" : "animate-pulse bg-muted-foreground/40")} />
          {connected
            ? "Connected — your device said hello."
            : "Waiting for the handshake — scan the code with WireGuard and connect."}
        </p>
        <Button className="mt-3" variant={connected ? "default" : "outline"} disabled={!connected} onClick={onConnected}>
          Continue
        </Button>
        {!connected && (
          <button className="ml-3 text-xs text-muted-foreground hover:text-foreground"
            onClick={onConnected}>Skip — I’ll connect later</button>
        )}
      </div>
    </section>
  )
}

/** Polls the peer list only while this step needs to show it. */
function usePeers(status: OnboardingStatus): WgPeer[] | undefined {
  const [peers, setPeers] = useState<WgPeer[] | undefined>(undefined)
  useEffect(() => {
    if (!status.adminClaimed) return
    let alive = true
    const tick = async () => {
      try {
        const res = await fetch("/api/bootstrap/wireguard")
        if (res.ok && alive) setPeers(((await res.json()) as { peers: WgPeer[] }).peers)
      } catch { /* transient — next tick retries */ }
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [status.adminClaimed])
  return peers
}

function PeerPanel({ peers }: { peers: WgPeer[] }) {
  const [selected, setSelected] = useState(peers[0]?.clientId ?? "")
  const peer = peers.find((p) => p.clientId === selected) ?? peers[0]
  if (!peer) return null
  return (
    <div className="mt-6">
      {peers.length > 1 && (
        <select aria-label="connection key" className="mb-3 w-full rounded-md border border-input bg-transparent p-2 text-sm"
          value={peer.clientId} onChange={(e) => setSelected(e.target.value)}>
          {peers.map((p) => <option key={p.clientId} value={p.clientId}>{p.name || p.clientId}</option>)}
        </select>
      )}
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-4">
        <img
          src={`/api/bootstrap/wireguard/clients/${encodeURIComponent(peer.clientId)}/qrcode.svg`}
          alt={`WireGuard configuration QR for ${peer.name}`}
          className="size-56 rounded bg-white p-2"
        />
        <a className="text-sm underline underline-offset-4"
          href={`/api/bootstrap/wireguard/clients/${encodeURIComponent(peer.clientId)}/configuration`} download>
          Download configuration file
        </a>
        <p className="text-xs text-muted-foreground">
          Install the WireGuard app, scan this code (or import the file), and switch the tunnel on.
        </p>
      </div>
    </div>
  )
}

function GraduateStep({ status }: { status: OnboardingStatus }) {
  return (
    <section className="text-center">
      <p className="text-sm text-muted-foreground">Your device now has a name.</p>
      <h1 className="mt-2 font-mono text-3xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Leave the raw address behind. The next screen asks you to sign in as{" "}
        <span className="font-mono">admin@{status.baseDomain}</span> with the password you
        set — that sign-in follows you into every app you install.
      </p>
      <Button className="mt-6" asChild>
        <a href={`https://${status.baseDomain}`}>Enter {status.baseDomain}</a>
      </Button>
    </section>
  )
}
```

- [ ] **Step 2: Write the tests**

`ui/packages/client/src/pages/onboarding/OnboardingPage.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage"
import type { OnboardingStatus } from "@librepod/shared"

const base: OnboardingStatus = {
  mode: "onboarding", arrival: "ip", baseDomain: "libre.pod",
  casdoorUp: true, wgEasyUp: false, adminClaimed: false, peerCount: null, lastHandshakeAt: null,
}

function withStatus(s: OnboardingStatus) {
  return render(
    <MemoryRouter>
      <OnboardingPage status={s} />
    </MemoryRouter>,
  )
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it("starts at Welcome for a fresh unclaimed device", () => {
    withStatus(base)
    expect(screen.getByText(/welcome to your librepod/i)).toBeVisible()
  })

  it("resume: claimed + no peers lands on Trust", () => {
    withStatus({ ...base, mode: "ready", adminClaimed: true, peerCount: 0 })
    expect(screen.getByText(/trust your device/i)).toBeVisible()
  })

  it("resume: peer exists + no handshake lands on Connect and shows the QR", () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ peers: [{ clientId: "c1", name: "phone", enabled: true, latestHandshakeAt: null }] }),
    } as Response)
    withStatus({ ...base, mode: "ready", adminClaimed: true, peerCount: 1 })
    expect(screen.getByText(/connect your first device/i)).toBeVisible()
    expect(screen.getByAltText(/QR for phone/i)).toHaveAttribute("src", "/api/bootstrap/wireguard/clients/c1/qrcode.svg")
  })

  it("handshake seen → Graduate leads with the domain", () => {
    withStatus({ ...base, mode: "ready", adminClaimed: true, peerCount: 1, lastHandshakeAt: "2026-09-05T10:00:00Z" })
    expect(screen.getByText("libre.pod")).toBeVisible()
    expect(screen.getByRole("link", { name: /enter libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
  })

  it("claim posts the password and advances", async () => {
    localStorage.setItem("librepod-onboarding-welcome", "1")
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ ok: true }) } as Response)
    withStatus(base)
    expect(screen.getByText("admin@libre.pod")).toBeVisible()
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "longenough1" } })
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "longenough1" } })
    fireEvent.click(screen.getByRole("button", { name: /claim this device/i }))
    await screen.findByText(/trust your device/i)
    const [url, init] = fetchMock.mock.calls.at(-1)!
    expect(String(url)).toBe("/api/bootstrap/claim")
    expect(JSON.parse(String(init!.body))).toEqual({ password: "longenough1" })
  })
})
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd ui && npm run test --workspace=packages/client`
Expected: PASS (new + all existing client tests). Fix label/role mismatches in tests vs component (labels must use `htmlFor`+`id` pairs exactly as written above).

- [ ] **Step 4: Commit**

```bash
git add ui/packages/client/src/pages/onboarding/
git commit -m "feat(ui): first-run onboarding wizard (claim/trust/connect/graduate)"
```

---

### Task 9: Kubernetes manifests (reflection, env, RBAC, CA mount)

**Files:**
- Modify: `apps/wg-easy/base/kustomization.yaml`
- Modify: `apps/marketplace-ui/base/configmap.yaml`
- Modify: `apps/marketplace-ui/base/kustomization.yaml`
- Modify: `apps/marketplace-ui/base/serviceaccount.yaml`
- Modify: `apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml`

**Interfaces:**
- Consumes: the server env contract from Tasks 2–5 (`CASDOOR_BASE_URL`, `WGEASY_BASE_URL`, `ROOT_CA_PATH`, factory file at `/etc/wg-easy/INIT_PASSWORD`, Secret `marketplace-ui-wg-easy`).
- Produces: reflected Secret `marketplace-ui/wg-easy-admin` (key `INIT_PASSWORD`), Role for the wg secret, root CA readable at `/mnt/root-ca/root_ca.crt` in the main container.

- [ ] **Step 1: wg-easy — reflect the factory secret with a stable name**

`apps/wg-easy/base/kustomization.yaml` — replace the `secretGenerator` block:

```yaml
secretGenerator:
- name: wg-easy-admin
  envs:
  - wg-easy-secret.env
  options:
    # Stable name: Reflector matches by namespace/name, a hash suffix would
    # break the cross-namespace copy into marketplace-ui. Content is static
    # (consumed only by wg-easy's first-boot unattended setup), so losing the
    # hash-based rollout trigger costs nothing.
    disableNameSuffixHash: true
    annotations:
      # Let the marketplace-ui onboarding wizard read the factory password
      # (INIT_PASSWORD) to drive wg-easy's API during first-run setup — the
      # same source-annotation pattern as gogs/components/bootstrap-admin.
      reflector.v1.k8s.emberstack.com/reflection-allowed: "true"
      reflector.v1.k8s.emberstack.com/reflection-auto-enabled: "true"
      reflector.v1.k8s.emberstack.com/reflection-auto-namespaces: "marketplace-ui"
```

- [ ] **Step 2: marketplace-ui — empty reflected stub + env + RBAC**

`apps/marketplace-ui/base/kustomization.yaml` — add a second secretGenerator entry next to `user-apps-git-auth`:

```yaml
- name: wg-easy-admin
  options:
    disableNameSuffixHash: true
    annotations:
      # Empty on purpose. Reflector mirrors wg-easy/wg-easy-admin into it so
      # the onboarding wizard can authenticate to the wg-easy API with the
      # factory credential (file /etc/wg-easy/INIT_PASSWORD).
      reflector.v1.k8s.emberstack.com/reflects: "wg-easy/wg-easy-admin"
```

`apps/marketplace-ui/base/configmap.yaml` — append to `data:`:

```yaml
  # In-cluster service URLs for first-run onboarding: the wizard proxies
  # Casdoor's admin API and wg-easy's API because the browser (raw IP, no DNS
  # yet) cannot reach either host. http, not https — cluster-internal traffic.
  CASDOOR_BASE_URL: "http://casdoor.casdoor.svc.cluster.local"
  WGEASY_BASE_URL: "http://wg-easy.wg-easy.svc.cluster.local"
```

`apps/marketplace-ui/base/serviceaccount.yaml` — append (same tight-scoping style as the bootstrap-session-secret Role):

```yaml
---
# Persist Secret/marketplace-ui-wg-easy — the wizard's rotated wg-easy admin
# password. Not in Git (like marketplace-ui-session), so Flux never prunes it.
# create cannot be scoped by resourceNames (the object doesn't exist yet),
# get/patch/update are locked to the one name.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: marketplace-ui-wg-easy-secret
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "patch", "update"]
    resourceNames: ["marketplace-ui-wg-easy"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: marketplace-ui-wg-easy-secret
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: marketplace-ui-wg-easy-secret
subjects:
  - kind: ServiceAccount
    name: marketplace-ui
    namespace: marketplace-ui
```

- [ ] **Step 3: deployment patch — mount factory password + root CA into the main container**

`apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml`:
(a) in `containers[0].volumeMounts` append:

```yaml
            - name: root-ca-cert
              mountPath: /mnt/root-ca
              readOnly: true
            - name: wg-easy-credentials
              mountPath: /etc/wg-easy
              readOnly: true
```

(b) in `containers[0].env` append:

```yaml
            - name: ROOT_CA_PATH
              value: /mnt/root-ca/root_ca.crt
```

(c) in `volumes` append:

```yaml
        # Reflected copy of wg-easy's factory admin password (INIT_PASSWORD).
        # Optional for the same reason as user-apps-git-credentials: an absent
        # Secret must not block the pod during bootstrap windows.
        - name: wg-easy-credentials
          secret:
            secretName: wg-easy-admin
            optional: true
```

(The `root-ca-cert` volume already exists in this patch — it currently feeds only the init container; the main-container mount above reuses it.)

- [ ] **Step 4: Validate rendered manifests**

```bash
cd /home/alex/code/librepod/marketplace
kustomize build apps/marketplace-ui/overlays/librepod | kubeconform -strict -summary \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
kustomize build apps/wg-easy/overlays/librepod | kubeconform -strict -summary \
  -schema-location default
```

Expected: kubeconform reports 0 failures for both. Also grep the rendered marketplace-ui Deployment for `CASDOOR_BASE_URL`, `WGEASY_BASE_URL`, `ROOT_CA_PATH`, both mounts, and confirm the wg-easy-admin Secret name rendered WITHOUT a hash suffix (`name: wg-easy-admin`).

- [ ] **Step 5: Commit**

```bash
git add apps/wg-easy/base/kustomization.yaml apps/marketplace-ui/
git commit -m "feat(marketplace-ui): onboarding wiring — reflected wg credential, RBAC, CA mount"
```

---

### Task 10: Tier-1 e2e regression — no SSO redirect on a fresh cluster

**Files:**
- Create: `ui/packages/e2e/tests/app-level/onboarding.spec.ts`

**Interfaces:**
- Consumes: Tier-1 harness (hermetic Gogs, prod-like server on :3100). In Tier 1 there is no casdoor — `CASDOOR_BASE_URL` is unset, so the probe returns `unreachable` and the status is `waiting`. That is exactly the fresh-cluster shape this regression pins: **the original bug was the instant redirect to an unresolvable id host.**

- [ ] **Step 1: Write the spec**

`ui/packages/e2e/tests/app-level/onboarding.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the Tier-1 suite**

Run: `cd ui && npm run test:e2e:ui -- tests/app-level/onboarding.spec.ts`
Expected: PASS. If the suite can't run in the current environment (docker/Gogs constraints), at minimum verify with `npx playwright test --list` that the spec is discovered, and run the server-unit + client suites — then state plainly in the PR which tiers ran.

- [ ] **Step 3: Commit**

```bash
git add ui/packages/e2e/tests/app-level/onboarding.spec.ts
git commit -m "test(ui): pin the no-SSO-redirect regression for fresh clusters"
```

---

### Task 11: Full verification + release lockstep

**Files:**
- Modify: `apps/marketplace-ui/metadata.yaml` (`spec.version`)
- Modify: `apps/marketplace-ui/overlays/librepod/kustomization.yaml` (`newTag`)
- Modify: `infrastructure/system-apps/marketplace-ui.yaml` (`ref.tag`) — grep first; the file owns the OCIRepository pin for marketplace-ui.

- [ ] **Step 1: Whole suite green**

```bash
cd ui && npm test && npm run test:client && npm run build:client && npm run build
```
Expected: all pass, both builds succeed.

- [ ] **Step 2: Version lockstep bump (3 spots, same number)**

`0.6.0` → `0.7.0` in:
1. `apps/marketplace-ui/metadata.yaml` → `spec.version`
2. `apps/marketplace-ui/overlays/librepod/kustomization.yaml` → `images[0].newTag`
3. `infrastructure/system-apps/marketplace-ui.yaml` → the OCIRepository `ref.tag`

Verify no stragglers: `rg -n '0\.6\.0' apps/marketplace-ui infrastructure/system-apps/marketplace-ui.yaml` → no hits.

- [ ] **Step 3: Commit**

```bash
git add apps/marketplace-ui/metadata.yaml apps/marketplace-ui/overlays/librepod/kustomization.yaml infrastructure/system-apps/marketplace-ui.yaml
git commit -m "chore(marketplace-ui): release 0.7.0 — first-run onboarding"
```

- [ ] **Step 4: PR**

Push a `feature/onboarding-claim-your-device` branch and open a PR (title: `feat(marketplace-ui): first-run onboarding — claim your device`). PR description covers: wizard flow, security model (factory window, onboarding cookie), and the refinements beyond the confirmed brief recorded in this plan: the single fixed owner `admin@<domain>` (password-only claim), one password shared with wg-easy (no SSO there; persisted to a cluster Secret — trade-off stated), and RootGate graduation keyed on the live WireGuard handshake. No device/cluster hostnames anywhere.

---

## Cluster verification checklist (post-merge, manual)

Not part of the tasks — the plan's evidence ends at Tier-1; on-cluster verification needs a live cluster and is listed here so it isn't forgotten:

1. Cold cluster (or one where casdoor's built-in admin still has password `123`): browse `http://<ip>` → Waking (if converging) → wizard.
2. Claim with a test user → verify `/api/bootstrap/status` flips to `ready`, a second browser on the LAN cannot claim (409), and casdoor's built-in admin no longer accepts `123`.
3. Trust step downloads the CA; Connect step creates a peer, shows the QR; connect a real WireGuard client → handshake flips the status → Graduate → `https://<base-domain>` resolves through the tunnel, first SSO login works as the new user.
4. `kubectl -n marketplace-ui get secret marketplace-ui-wg-easy` exists and holds the chosen password; the wg-easy UI at `wg.<domain>` logs in with that same password and rejects `ChangeMeOnFirstLogin!`.
5. Post-graduation: `http://<ip>` shows the use-domain screen; `/api/bootstrap/wireguard/peer` from a cookie-less client returns 401.
