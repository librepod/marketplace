# First-Run Onboarding with a Setup Code — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A raw-IP web wizard that takes a fresh LibrePod from `http://<ip>` to a claimed device (setup code + admin password), a personal account, connectivity (WireGuard or "bring my own"), a trusted root CA and the first SSO sign-in at `https://<base-domain>`, which closes onboarding for good.

**Architecture:** marketplace-ui keeps one onboarding record in OpenBao `system/marketplace-ui/onboarding` (`open → claimed → finished`, plus a computed `waiting`) and the admin password in `system/admin`. A setup code created on first start (KV check-and-set) and printed to the pod log is the proof of ownership. The claim and resume endpoints set an HMAC onboarding cookie bound to the record's `generation`; `OnboardingGuard` accepts it only while the record is `claimed`. The SSO callback finishes onboarding. `reset-onboarding` (shipped in the image) issues a new code and bumps the generation. The surviving parts of PR #215 (DEVICE_IP, wg-easy as a catalog app, the wg-easy proxy, the CA endpoint, RootGate and the wizard steps) are carried over as clean commits.

**Tech Stack:** NestJS 11 + vitest + supertest (server), React 19 + TanStack Query + Testing Library (client), Playwright (Tier 1), Kustomize/Flux manifests, OpenBao KV v2, Casdoor v3.106 admin API, wg-easy v15.4.

**Spec:** `docs/superpowers/specs/2026-10-14-onboarding-setup-code-design.md` (commit d73e707). The plan argues from it; read both. Where they disagree, the spec wins, except for the rulings listed below.

## Global Constraints

- **Worktree:** `/home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code`, branch `feat/onboarding-setup-code`. Every shell command starts with `cd` to an absolute path inside it. Subagents have committed into the main checkout by mistake before. After every commit, run `git -C /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code log --oneline -1` and confirm the commit is there.
- **Never** push, open or edit a PR, touch PR #215, or touch any cluster. No `kubectl` against a cluster appears in this plan.
- **Never** put device or cluster hostnames in commit messages, PR text or public docs (README). Use `dev`/`prod` or placeholders like `<device-ip>`.
- **Commits:** one conventional commit per green task (more only where a step says so). `git add` only the paths the task lists. Never `git add -A`.
- **Carry-over source:** PR #215 lives at commit `b42337c` (branch `feat/onboarding-flow`). Its merge base with master is `db77265`. "Carry" means applying #215's change as a 3-way patch onto this branch:
  `git diff db77265 b42337c -- <paths> | git apply --3way`. This stages the result. Master has not touched any carried file since `db77265`; a conflict means something unexpected — stop and report.
- **Password rule (admin and personal), server and browser:** at least 12 characters, no whitespace. Server message: `Use at least 12 characters, without spaces`.
- **Setup code:**
  - 12 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, displayed as `XXXX-XXXX-XXXX`.
  - Input is upper-cased with dashes and whitespace stripped, then compared in constant time.
  - A wrong code is a 403 `That setup code isn't right`, logged with the source address and never the value.
- **Log line, verbatim**, on every start while the record is `open` or `claimed`, and never once it is `finished`:
  `LibrePod setup code: <XXXX-XXXX-XXXX> — open http://<this device's IP> to set up`. The `<this device's IP>` part is literal text.
- **Commands to document:**
  - Read the code: `kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"`.
  - Reset: `kubectl -n marketplace-ui exec deploy/marketplace-ui -- reset-onboarding`.
- **OpenBao (KV v2 mount `system`, env `OPENBAO_SYSTEM_MOUNT`, default `system`):**
  - `system/marketplace-ui/onboarding` holds `state, code, generation, account, accountGeneration, createdAt, claimedAt, finishedAt`.
  - `system/admin` holds `password`.
- **Onboarding cookie `mp_onboarding`:**
  - Signed by `SessionService` with `{ sub: 'onboarding', name: 'onboarding', email: '', generation }`. TTL is `SessionService.ttlSeconds` (8h).
  - `httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, and **no** `secure`.
  - Set only by claim and resume. `AuthGuard` never accepts it.
- **Messages, verbatim:** `That setup code isn't right` (403) and `Casdoor's admin password was changed outside LibrePod` (409).
- **Status shape:** `OnboardingStatus` from Task 9 (the spec's shape plus `previousAccount`, ruling R1). `BOOTSTRAP_MODE_OVERRIDE` stays the test seam; Tier 1 sets `finished`.
- **Code style:** match the surrounding code.
  - Server: single quotes and semicolons.
  - Client: double quotes, no semicolons.
  - Shared types: semicolons.
  - Comment density stays at the level of neighbouring files.
- **Checks:**
  - Server unit, one file: `cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run <file>`.
  - Server unit, all: `cd …/ui && npm test`.
  - Server e2e: `cd …/ui && npm run test:e2e`.
  - Client, one file: `cd …/ui/packages/client && npx vitest run <file>`.
  - Client, all: `cd …/ui && npm run test:client`.
  - Builds: `cd …/ui && npm run build && npm run build:client`.
  - Server typecheck (SWC does not typecheck): `cd …/ui/packages/server && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo`.
  - Manifests: `kustomize build <dir> | kubeconform -strict -summary -ignore-missing-schemas -schema-location default`. If `kustomize` or `kubeconform` is missing, run the same command inside `nix-shell /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/shell.nix --run '…'`.
- **Security hook:** if a security hook rejects a Bash command (it dislikes some `grep` patterns), use the Read/Edit tools for that step instead. Do not rephrase the command to get around the hook.

## Rulings made while planning (spec gaps)

- **R1 — Account step after a reset.** The spec keeps `account` across a reset, so Account can offer "keep alex". It also derives the Account step from "no account recorded" and calls Account the recovery for a lost personal password. Both cannot hold.
  - The record gains `accountGeneration`, the generation in which the Account step last ran.
  - Status `account` is the account confirmed since the last claim (`accountGeneration === generation`), so the spec's derivation rule stays literal.
  - A new status field, `previousAccount`, carries an account kept from before a reset.
- **R2 — Casdoor reachability** uses `GET <CASDOOR_BASE_URL>/.well-known/openid-configuration`. It is unauthenticated JSON, so status never logs in.
- **R3 — `get-organization` takes `id=admin/<org>`.** Casdoor ids are `owner/name`, and organizations belong to `admin`. #215's bare `id=librepod` would error. An error response is surfaced, never treated as "missing".
- **R4 — Bootstrap POSTs return 200** (`@HttpCode(200)` on claim, resume, account and install).
- **R5 — No `/onboarding` route.** RootGate renders the wizard at any path for a raw-IP arrival in `open`/`claimed`. UseDomainScreen drops #215's "Show my connection keys" link, because after `finished` there is no wizard.
- **R6 — Graduate offers "Connect another device".** It opens Connect even after a handshake. Without it, §6's "a lost VPN key: the reopened wizard can create a new one" has no path, because the derived step would be Graduate.
- **R7 — Store bootstrapping.**
  - `OPENBAO_SYSTEM_MOUNT` is configurable (default `system`).
  - `OnboardingStore` skips record creation when `BOOTSTRAP_MODE_OVERRIDE` is set, because Tier 1's dev-mode OpenBao has no `system/` mount.
- **R8 — Claim and resume check the state first (409), then the code.** Status is public, so the order leaks nothing.
- **R9 — Only a sign-in since the claim finishes.** `finishIfClaimed(signedInAtMs)` finishes only when the sign-in happened at or after `claimedAt`. The status retry passes the SSO session's `iat`. Otherwise a session from before a reset would end the reopened wizard the moment the owner claims again.
- **R10 — `OnboardingStore` gets its own module (`OnboardingStoreModule`).** AuthModule imports it for the callback hook; OnboardingModule imports AuthModule for `SessionService`. A separate module avoids the cycle.
- **R11 — `record()` creates the record when start-up hasn't yet.** It uses the same check-and-set creation as start-up. Without it, status would say `waiting` for up to a minute (the start-up retry backoff) after OpenBao comes up. This is the only write a GET can cause besides the finish retry, and it is idempotent.

## Review Focus

Most likely first:

1. **Old cookies.** A browser holding an onboarding cookie from before a reset, or from after finishing, must be refused by every cookie-gated endpoint and shown `session: false`. *Task 8 guard spec, Task 11 e2e reset test.*
2. **Typed codes.** A setup code typed in lowercase, with spaces or with dashes must be accepted. A code from before a reset must be refused. *Task 4 spec, Task 11 e2e.*
3. **Bad bodies.** Bodyless or wrongly typed POSTs to claim, resume, account, install and peer must get a 4xx, never a 500. *Task 11 e2e "malformed bodies".*
4. **Outages mid-flow.** With OpenBao or Casdoor down, status says `waiting` (never for a signed-in user), and claim, resume and account answer 503 without half-writing the record. *Task 10 service spec, Task 11 controller spec and e2e "OpenBao down".*
5. **Catalog wg-easy installs.** An install outside the wizard with an empty "Endpoint host" answer must not leave an empty `INIT_HOST` in the settings Secret, and master's `change-me` admin password default must be gone. *Task 2 `wg-easy-catalog.spec.ts`.*

## File map

Server (`ui/packages/server/`):

| File | Responsibility | Task |
|---|---|---|
| `src/installed/node-address.service.ts` (+spec) | `DEVICE_IP` = this node's InternalIP | 1 (carry) |
| `src/installed/installed.service.ts`, `installed.module.ts`, `install-settings.ts` | DEVICE_IP render, `appStatus()`, exports | 1 (carry) |
| `src/installed/wg-easy-catalog.spec.ts` | pins wg-easy's catalog contract | 2 |
| `src/installed/openbao.client.ts` | + `readEntry`/`writeEntry` (check-and-set) | 3 |
| `src/onboarding/setup-code.ts` | generate / format / normalize / compare | 4 |
| `src/onboarding/onboarding-store.ts`, `onboarding-store.module.ts` | the record + admin password, start-up, cache, finish, reset | 5 |
| `test/fixtures/fake-kv.ts` | in-memory KV v2 with CAS (unit + e2e) | 5 |
| `src/onboarding/openbao-policy.spec.ts` | pins the OpenBao policy to the store's paths | 6 |
| `src/onboarding/casdoor-admin.service.ts` | Casdoor admin API as the built-in admin | 7 |
| `src/auth/auth.guard.ts`, `auth.types.ts`, `auth.controller.ts`, `auth.module.ts` | onboarding-token rejection, `generation`, finish hook | 8 |
| `src/onboarding/onboarding.guard.ts` | cookie + record gate | 8 |
| `src/onboarding/wg-easy.service.ts`, `wireguard.controller.ts` | wg-easy proxy | 9 (carry) |
| `src/onboarding/onboarding.service.ts`, `test/fixtures/fake-casdoor.ts` | claim / resume / account | 10 |
| `src/onboarding/bootstrap.controller.ts`, `onboarding.module.ts`, `src/app.module.ts`, `test/onboarding.e2e-spec.ts` | HTTP surface | 11 |
| `src/onboarding/reset-onboarding.ts`, `reset-onboarding.cli.ts`, `bin/reset-onboarding`, `ui/Dockerfile` | reset command | 12 |

Shared and client:

| File | Responsibility | Task |
|---|---|---|
| `ui/packages/shared/src/types.ts` | onboarding types | 9 |
| `ui/packages/client/src/pages/onboarding/api.ts`, `AccessSteps.tsx` | Welcome, Claim, Resume, Account | 14 |
| `ui/packages/client/src/pages/onboarding/ConnectivitySteps.tsx` | VPN, Trust, Connect, Graduate | 15 |
| `ui/packages/client/src/pages/onboarding/OnboardingPage.tsx` | step derivation, composition | 16 |
| `ui/packages/client/src/components/{RootGate,PreAuthScreens}.tsx`, `hooks/useBootstrapStatus.ts`, `router.tsx` | the state × arrival router | 17 |

Manifests and docs:

| File | Responsibility | Task |
|---|---|---|
| `apps/wg-easy/{metadata.yaml,base/wg-easy.env}` | catalog app + `INIT_HOST` | 2 |
| `apps/openbao/...` | `marketplace-ui-system` policy | 6 |
| `apps/marketplace-ui/...`, `infrastructure/system-apps/marketplace-ui.yaml`, `ui/package*.json` | env, CA mount, version 0.9.0 | 1, 13 |
| `ui/packages/e2e/...` | Tier 1 invariant | 18 |
| `README.md`, `ui/CLAUDE.md`, `ui/PRODUCT.md` | docs | 19 |

---
### Task 1: DEVICE_IP platform variable and `appStatus()` (carried from #215)

**Files:**
- Create (carry): `ui/packages/server/src/installed/node-address.service.ts`, `ui/packages/server/src/installed/node-address.service.spec.ts`
- Modify (carry): `ui/packages/server/src/installed/installed.service.ts`, `installed.service.spec.ts`, `installed.module.ts`, `install-settings.ts`, `install-settings.spec.ts`, `rbac-manifest.spec.ts`
- Modify (carry): `apps/marketplace-ui/base/serviceaccount.yaml` (`get nodes`), `apps/marketplace-ui/base/deployment.yaml` (`NODE_NAME`)
- Modify (carry): `.claude/skills/librepod-app/SKILL.md`, `.claude/skills/verify-app/SKILL.md`, `.claude/skills/verify-app/scripts/render-templates.py`
- Then adapt: `ui/packages/server/src/installed/installed.module.ts` (also export `NodeAddressService`)

**Interfaces:**
- Produces:
  - `NodeAddressService.internalIp(): Promise<string>`: 503 `Couldn't determine this device's address. Try again in a minute.` on failure.
  - `InstalledService.appStatus(appName: string): Promise<AppStatus>`.
  - `InstalledModule` exports `[InstalledService, OpenBaoClient, NodeAddressService]`.
  - `RESERVED_NAMES` includes `DEVICE_IP`.
  - The installer renders `${DEVICE_IP}` only for templates that contain it, after settings validation and before any write.

- [ ] **Step 1: Install dependencies in the fresh worktree**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm ci
```
Expected: completes without errors.

- [ ] **Step 2: Carry the #215 change**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git diff db77265 b42337c -- \
  ui/packages/server/src/installed/node-address.service.ts \
  ui/packages/server/src/installed/node-address.service.spec.ts \
  ui/packages/server/src/installed/installed.service.ts \
  ui/packages/server/src/installed/installed.service.spec.ts \
  ui/packages/server/src/installed/installed.module.ts \
  ui/packages/server/src/installed/install-settings.ts \
  ui/packages/server/src/installed/install-settings.spec.ts \
  ui/packages/server/src/installed/rbac-manifest.spec.ts \
  apps/marketplace-ui/base/serviceaccount.yaml \
  apps/marketplace-ui/base/deployment.yaml \
  .claude/skills/librepod-app/SKILL.md \
  .claude/skills/verify-app/SKILL.md \
  .claude/skills/verify-app/scripts/render-templates.py \
  | git apply --3way
git status --short
```
Expected: the 13 paths are staged (`A`/`M`), with no conflict markers.

- [ ] **Step 3: Export `NodeAddressService` for onboarding's endpoint suggestion**

In `ui/packages/server/src/installed/installed.module.ts`, replace

```ts
  exports: [InstalledService, OpenBaoClient],
```

with

```ts
  // OpenBaoClient and NodeAddressService also serve first-run onboarding
  // (src/onboarding): one OpenBao login, one node lookup.
  exports: [InstalledService, OpenBaoClient, NodeAddressService],
```

- [ ] **Step 4: Run the carried tests**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/installed
```
Expected: PASS, including `NodeAddressService.internalIp` (3 tests), `appStatus()`, `install() DEVICE_IP` (4 tests), `reserves both platform variables`, and `grants get on core nodes`.

- [ ] **Step 5: Typecheck, render-script and manifest checks**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code && python3 .claude/skills/verify-app/scripts/render-templates.py --help | grep -A2 -- '--device-ip'
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code && kustomize build apps/marketplace-ui/overlays/librepod | kubeconform -strict -summary -ignore-missing-schemas -schema-location default
```
Expected:
- tsc exits 0.
- The help text shows `--device-ip`.
- kubeconform reports `Invalid: 0, Errors: 0`.

- [ ] **Step 6: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/installed .claude/skills/librepod-app/SKILL.md .claude/skills/verify-app apps/marketplace-ui/base/serviceaccount.yaml apps/marketplace-ui/base/deployment.yaml
git commit -m "feat(ui): DEVICE_IP platform variable — the node's InternalIP for templates that ask for it"
git log --oneline -1
```

---

### Task 2: wg-easy as a catalog app with an "Endpoint host" question

**Files:**
- Modify (carry, then edit): `apps/wg-easy/metadata.yaml`, `apps/wg-easy/base/wg-easy.env`
- Modify (carry): `apps/wg-easy/components/frp-upstreams/kustomization.yaml` (comment only)
- Create: `ui/packages/server/src/installed/wg-easy-catalog.spec.ts`

**Interfaces:**
- Consumes: `resolveSettings` from `src/installed/install-settings.ts` (unchanged).
- Produces, the wg-easy catalog contract that Task 11's install endpoint relies on:
  - The settings items are `INIT_PASSWORD` (required, sensitive, no default) and `INIT_HOST` (optional, no default).
  - `templates.release` substitutes exactly `BASE_DOMAIN` and `DEVICE_IP`.

- [ ] **Step 1: Write the failing contract test**

Create `ui/packages/server/src/installed/wg-easy-catalog.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { AppSettings } from '@librepod/shared';
import { resolveSettings } from './install-settings';

/**
 * wg-easy's catalog entry is a contract with the first-run wizard: the wizard
 * answers INIT_PASSWORD (server-side, from OpenBao system/admin) and INIT_HOST
 * (the endpoint the owner confirmed), and the release must substitute only
 * the two platform variables the installer fills. The app lives in the
 * marketplace repo, five levels up from packages/server/src/installed.
 */
const APP = join(__dirname, '../../../../../apps/wg-easy');
const metadata = load(readFileSync(join(APP, 'metadata.yaml'), 'utf8')) as {
  spec: { settings: AppSettings; templates: { release: string } };
};
const settings = metadata.spec.settings;
const item = (name: string) => settings.items?.find((i) => i.name === name);

describe('wg-easy catalog entry', () => {
  it('asks for the admin password with no default — master\'s "change-me" was too short to ever log in', () => {
    expect(item('INIT_PASSWORD')).toMatchObject({ required: true, sensitive: true });
    expect(item('INIT_PASSWORD')?.default).toBeUndefined();
    expect(item('INIT_PASSWORD')?.description).toMatch(/12 characters/);
  });

  it('asks for an optional endpoint host with no default', () => {
    expect(item('INIT_HOST')).toMatchObject({ label: 'Endpoint host' });
    expect(item('INIT_HOST')?.required).toBeFalsy();
    expect(item('INIT_HOST')?.default).toBeUndefined();
  });

  it('an empty endpoint answer never becomes an empty key in the settings Secret', () => {
    const resolved = resolveSettings(settings, { settings: { INIT_PASSWORD: 'correct-horse-12', INIT_HOST: '' } });
    expect(resolved).toEqual({ ok: true, values: { INIT_PASSWORD: 'correct-horse-12' } });
  });

  it('a non-empty endpoint answer is stored, so it overrides the ConfigMap default', () => {
    const resolved = resolveSettings(settings, { settings: { INIT_PASSWORD: 'correct-horse-12', INIT_HOST: '203.0.113.7' } });
    expect(resolved).toEqual({ ok: true, values: { INIT_PASSWORD: 'correct-horse-12', INIT_HOST: '203.0.113.7' } });
  });

  it('no admin password is an error, not a fallback', () => {
    expect(resolveSettings(settings, { settings: {} })).toEqual({
      ok: false,
      errors: [{ name: 'INIT_PASSWORD', message: 'Required' }],
    });
  });

  it('the release substitutes exactly BASE_DOMAIN and DEVICE_IP', () => {
    const release = load(metadata.spec.templates.release) as { spec: { postBuild: { substitute: Record<string, string> } } };
    expect(Object.keys(release.spec.postBuild.substitute).sort()).toEqual(['BASE_DOMAIN', 'DEVICE_IP']);
  });

  it("the endpoint default is the device's IP, empty (never junk) when unsubstituted", () => {
    const env = readFileSync(join(APP, 'base/wg-easy.env'), 'utf8');
    expect(env).toMatch(/^INIT_HOST=\$\{DEVICE_IP:=\}$/m);
    expect(env).not.toContain('FRP_SERVER_ADDR');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/installed/wg-easy-catalog.spec.ts
```
Expected: FAIL. `INIT_PASSWORD` has default `change-me`, `INIT_HOST` is missing, and the substitute keys include `FRP_SERVER_ADDR`.

- [ ] **Step 3: Carry #215's wg-easy change**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git diff db77265 b42337c -- apps/wg-easy/metadata.yaml apps/wg-easy/base/wg-easy.env apps/wg-easy/components/frp-upstreams/kustomization.yaml | git apply --3way
```

- [ ] **Step 4: Add the `INIT_HOST` question**

In `apps/wg-easy/metadata.yaml`, replace this block (as carried from #215):

```yaml
  # One install question: the local admin password — the fallback login
  # (single sign-on is the primary one). The onboarding wizard offers the
  # owner's LibrePod admin password here. wg-easy rejects passwords shorter than
  # 12 characters at login; the settings contract has no length rule, so
  # the description states it (the wizard enforces it client-side).
  settings:
    items:
      - name: INIT_PASSWORD
        label: "Admin password"
        description: "Password for the built-in admin account, applied on first start. Use your LibrePod admin password. At least 12 characters — wg-easy rejects shorter ones at login. Single sign-on is the primary login; this is the fallback."
        sensitive: true
        required: true
```

with:

```yaml
  # Two install questions. The first-run wizard answers both: INIT_PASSWORD
  # with the LibrePod admin password (server-side, from OpenBao system/admin)
  # and INIT_HOST with the endpoint the owner confirmed. wg-easy rejects admin
  # passwords shorter than 12 characters at login; the settings contract has
  # no length rule, so the description states it. An empty INIT_HOST answer is
  # never stored, so the ConfigMap's ${DEVICE_IP} default applies.
  settings:
    items:
      - name: INIT_PASSWORD
        label: "Admin password"
        description: "Password for wg-easy's built-in admin account, applied on first start. Use your LibrePod admin password — at least 12 characters, or wg-easy rejects it at login. Single sign-on is the primary login; this is the fallback."
        sensitive: true
        required: true
      - name: INIT_HOST
        label: "Endpoint host"
        description: "The address your devices dial to reach this VPN, applied on first start. Leave empty to use this device's IP address."
```

- [ ] **Step 5: Say how `INIT_HOST` is overridden**

In `apps/wg-easy/base/wg-easy.env`, replace (as carried):

```
# WireGuard endpoint host baked into client configs: the device's LAN IP,
# passed by marketplace-ui as DEVICE_IP at install time. Empty (never junk)
# if this is ever applied without substitution — wg-easy's unattended setup
# then waits instead of baking a wrong host into every client config.
INIT_HOST=${DEVICE_IP:=}
```

with:

```
# WireGuard endpoint host baked into client configs. Default: the device's IP,
# passed by marketplace-ui as DEVICE_IP at install time. The optional INIT_HOST
# install question overrides it: the wg-easy-settings Secret comes after this
# ConfigMap in envFrom, so a non-empty answer wins, and an empty answer is never
# written. Empty (never junk) if this is ever applied without substitution —
# wg-easy's unattended setup then waits instead of baking a wrong host into
# every client config.
INIT_HOST=${DEVICE_IP:=}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/installed/wg-easy-catalog.spec.ts
```
Expected: PASS (7 tests).

- [ ] **Step 7: Manifest and render checks**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
kustomize build apps/wg-easy/overlays/librepod | kubeconform -strict -summary -ignore-missing-schemas -schema-location default
python3 .claude/skills/verify-app/scripts/render-templates.py --app wg-easy --device-ip 192.168.1.50 --output-dir /tmp/claude-1000/verify-wg-easy && grep -r 'DEVICE_IP' /tmp/claude-1000/verify-wg-easy
```
Expected:
- kubeconform reports `Invalid: 0, Errors: 0`.
- The rendered `release.yaml` contains `DEVICE_IP: "192.168.1.50"` and no literal `${DEVICE_IP}`.

- [ ] **Step 8: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add apps/wg-easy/metadata.yaml apps/wg-easy/base/wg-easy.env apps/wg-easy/components/frp-upstreams/kustomization.yaml ui/packages/server/src/installed/wg-easy-catalog.spec.ts
git commit -m "feat(wg-easy): catalog app answered by the setup wizard — required admin password, optional endpoint host"
git log --oneline -1
```

---
### Task 3: OpenBao KV entries with check-and-set

**Files:**
- Modify: `ui/packages/server/src/installed/openbao.client.ts`
- Test: `ui/packages/server/src/installed/openbao.client.spec.ts` (append)

**Interfaces:**
- Produces:
  - `class OpenBaoCasMismatchError extends Error`.
  - `interface KvEntry { data: Record<string, unknown>; version: number }`.
  - `OpenBaoClient.readEntry(mount: string, path: string): Promise<KvEntry | null>`.
  - `OpenBaoClient.writeEntry(mount: string, path: string, data: Record<string, unknown>, opts?: { cas?: number }): Promise<void>`.
  - `readAppSettings`/`writeAppSettings` keep their signatures and behaviour and now delegate to these.
  - Path segments are URI-encoded, and slashes are kept (`marketplace-ui/onboarding`).

- [ ] **Step 1: Write the failing tests**

Change the import at the top of `openbao.client.spec.ts` to

```ts
import { OpenBaoCasMismatchError, OpenBaoClient, OpenBaoMisconfiguredError, OpenBaoUnavailableError } from './openbao.client';
```

and append inside the top-level `describe('OpenBaoClient', …)` block (before its closing `});`):

```ts
  describe('KV entries (readEntry / writeEntry)', () => {
    it('reads an entry with its version; nested paths keep their slashes', async () => {
      fetchMock.mockResolvedValueOnce(json({ data: { data: { state: 'open', generation: 1 }, metadata: { version: 3 } } }));
      const entry = await staticClient().readEntry('system', 'marketplace-ui/onboarding');
      expect(entry).toEqual({ data: { state: 'open', generation: 1 }, version: 3 });
      expect(fetchMock.mock.calls[0][0]).toBe(`${ADDR}/v1/system/data/marketplace-ui/onboarding`);
    });

    it('a missing entry reads as null', async () => {
      fetchMock.mockResolvedValueOnce(json({ errors: [] }, 404));
      expect(await staticClient().readEntry('system', 'admin')).toBeNull();
    });

    it('writes typed values verbatim, with no options unless check-and-set is asked for', async () => {
      fetchMock.mockResolvedValueOnce(writeOk());
      await staticClient().writeEntry('system', 'admin', { password: 'p', n: 1, gone: null });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${ADDR}/v1/system/data/admin`);
      expect(JSON.parse(init.body as string)).toEqual({ data: { password: 'p', n: 1, gone: null } });
    });

    it('check-and-set sends options.cas and reports a lost race as OpenBaoCasMismatchError', async () => {
      fetchMock.mockResolvedValueOnce(json({ errors: ['check-and-set parameter did not match the current version'] }, 400));
      const err = await staticClient()
        .writeEntry('system', 'marketplace-ui/onboarding', { a: 1 }, { cas: 0 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpenBaoCasMismatchError);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual({ options: { cas: 0 }, data: { a: 1 } });
    });

    it('any other 400 on a check-and-set write stays a misconfiguration', async () => {
      fetchMock.mockResolvedValueOnce(json({ errors: ['no handler for route "nomount/data/x"'] }, 400));
      await expect(staticClient().writeEntry('nomount', 'x', { a: 1 }, { cas: 0 })).rejects.toBeInstanceOf(
        OpenBaoMisconfiguredError,
      );
    });

    it('a 5xx is retryable', async () => {
      fetchMock.mockResolvedValueOnce(json({ errors: ['sealed'] }, 503));
      await expect(staticClient().readEntry('system', 'admin')).rejects.toBeInstanceOf(OpenBaoUnavailableError);
    });

    it('refuses without OPENBAO_ADDR, before any request', async () => {
      const client = new OpenBaoClient(configOf({}));
      await expect(client.readEntry('system', 'admin')).rejects.toBeInstanceOf(OpenBaoMisconfiguredError);
      await expect(client.writeEntry('system', 'admin', {})).rejects.toBeInstanceOf(OpenBaoMisconfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/installed/openbao.client.spec.ts
```
Expected: FAIL, because `readEntry is not a function` / `OpenBaoCasMismatchError` is undefined.

- [ ] **Step 3: Implement**

In `openbao.client.ts`, add after the `OpenBaoMisconfiguredError` class:

```ts
/** A check-and-set write lost the race: the entry changed since it was read. */
export class OpenBaoCasMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenBaoCasMismatchError';
  }
}

/** One KV v2 entry: its data and its version (the check-and-set handle). */
export interface KvEntry {
  data: Record<string, unknown>;
  version: number;
}
```

Replace the bodies of `writeAppSettings` and `readAppSettings` (keep their doc comments) and add the generic methods after them:

```ts
  async writeAppSettings(app: string, data: Record<string, string>): Promise<void> {
    await this.writeEntry(this.config.get<string>('OPENBAO_KV_MOUNT', 'secret'), app, data);
  }

  async readAppSettings(app: string): Promise<Record<string, string> | null> {
    const entry = await this.readEntry(this.config.get<string>('OPENBAO_KV_MOUNT', 'secret'), app);
    return entry ? (entry.data as Record<string, string>) : null;
  }

  /** The KV v2 entry <mount>/<path>, or null when it was never written. */
  async readEntry(mount: string, path: string): Promise<KvEntry | null> {
    const url = this.entryUrl(mount, path);
    let res = await this.get(url, { 'X-Vault-Token': await this.clientToken() });
    if (res.status === 403 && this.token) {
      // The cached login token expired or was revoked early: log in again, once.
      this.token = undefined;
      res = await this.get(url, { 'X-Vault-Token': await this.clientToken() });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw failure(`read ${mount}/${path}`, res.status);
    const body = (await res.json()) as {
      data?: { data?: Record<string, unknown>; metadata?: { version?: number } };
    };
    return { data: body.data?.data ?? {}, version: body.data?.metadata?.version ?? 0 };
  }

  /**
   * Replaces the whole KV v2 entry <mount>/<path> (a new version; earlier ones stay as
   * history). With `cas` the write is check-and-set: it lands only while the entry is still
   * at that version — 0 means "only if it does not exist yet" — else OpenBaoCasMismatchError.
   */
  async writeEntry(
    mount: string,
    path: string,
    data: Record<string, unknown>,
    opts: { cas?: number } = {},
  ): Promise<void> {
    const url = this.entryUrl(mount, path);
    const body = opts.cas === undefined ? { data } : { options: { cas: opts.cas }, data };
    let res = await this.post(url, body, { 'X-Vault-Token': await this.clientToken() });
    if (res.status === 403 && this.token) {
      // The cached login token expired or was revoked early: log in again, once.
      this.token = undefined;
      res = await this.post(url, body, { 'X-Vault-Token': await this.clientToken() });
    }
    if (opts.cas !== undefined && res.status === 400 && /check-and-set/i.test(await res.text().catch(() => ''))) {
      throw new OpenBaoCasMismatchError(`write ${mount}/${path}: the entry changed since it was read`);
    }
    if (!res.ok) throw failure(`write ${mount}/${path}`, res.status);
  }

  private entryUrl(mount: string, path: string): string {
    if (!this.addr) throw new OpenBaoMisconfiguredError('OPENBAO_ADDR is not set');
    return `${this.addr}/v1/${mount}/data/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
```

Also update the class doc comment's first sentence from "a Kubernetes-auth login and one KV v2 entry read back before an install and rewritten by it" to "a Kubernetes-auth login and KV v2 entries: one per app (read back before an install and rewritten by it) and onboarding's entries under the system mount".

- [ ] **Step 4: Run all OpenBao and installer tests**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/installed && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
```
Expected: PASS (the existing app-settings tests unchanged, plus the 7 new ones); tsc exits 0.

- [ ] **Step 5: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/installed/openbao.client.ts ui/packages/server/src/installed/openbao.client.spec.ts
git commit -m "feat(ui): OpenBao client reads and writes any KV entry, with check-and-set"
git log --oneline -1
```

---

### Task 4: Setup code

**Files:**
- Create: `ui/packages/server/src/onboarding/setup-code.ts`
- Test: `ui/packages/server/src/onboarding/setup-code.spec.ts`

**Interfaces:**
- Produces:
  - `SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'` and `SETUP_CODE_LENGTH = 12`.
  - `generateSetupCode(randomInt?: (max: number) => number): string`: 12 characters, no dashes.
  - `formatSetupCode(code: string): string` gives `XXXX-XXXX-XXXX`.
  - `normalizeSetupCode(input: string): string`.
  - `setupCodeMatches(input: unknown, code: string): boolean`: constant time; `false` for non-strings.

- [ ] **Step 1: Write the failing test**

Create `ui/packages/server/src/onboarding/setup-code.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SETUP_CODE_ALPHABET,
  formatSetupCode,
  generateSetupCode,
  normalizeSetupCode,
  setupCodeMatches,
} from './setup-code';

describe('setup code', () => {
  it('is 12 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSetupCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
    }
  });

  it('the alphabet has no 0/O or 1/I/L — 31 characters, about 59 bits for 12', () => {
    expect(SETUP_CODE_ALPHABET).not.toMatch(/[0O1IL]/);
    expect(SETUP_CODE_ALPHABET).toHaveLength(31);
  });

  it('draws every character from the random source over the whole alphabet', () => {
    const bounds: number[] = [];
    const code = generateSetupCode((max) => {
      bounds.push(max);
      return 0;
    });
    expect(bounds).toEqual(Array(12).fill(31));
    expect(code).toBe('AAAAAAAAAAAA');
  });

  it('formats as three groups of four', () => {
    expect(formatSetupCode('7KQMX3RT9VHC')).toBe('7KQM-X3RT-9VHC');
  });

  it('normalizes what a person types: upper-case, no dashes, no whitespace', () => {
    expect(normalizeSetupCode(' 7kqm-x3rt 9vhc\t')).toBe('7KQMX3RT9VHC');
  });

  it('matches the code however it is typed', () => {
    for (const typed of ['7KQM-X3RT-9VHC', '7kqm-x3rt-9vhc', ' 7KQM X3RT 9VHC ', '7KQMX3RT9VHC']) {
      expect(setupCodeMatches(typed, '7KQMX3RT9VHC')).toBe(true);
    }
  });

  it('rejects a wrong, partial, longer, empty or non-text code', () => {
    for (const typed of ['7KQM-X3RT-9VHD', '7KQM-X3RT', '7KQM-X3RT-9VHC-2222', '', 42, null, undefined, {}]) {
      expect(setupCodeMatches(typed, '7KQMX3RT9VHC')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/setup-code.spec.ts
```
Expected: FAIL, because `./setup-code` does not exist.

- [ ] **Step 3: Implement**

Create `ui/packages/server/src/onboarding/setup-code.ts`:

```ts
import * as crypto from 'node:crypto';

/** No 0/O and no 1/I/L: a code read off a log or a screen is typed without guessing. */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 31^12 ≈ 2^59 — guessing over the network is not realistic, so attempts are not rate-limited. */
export const SETUP_CODE_LENGTH = 12;

/** A fresh setup code, stored and compared without dashes. */
export function generateSetupCode(randomInt: (max: number) => number = crypto.randomInt): string {
  let code = '';
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) {
    code += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  }
  return code;
}

/** 7KQMX3RT9VHC → 7KQM-X3RT-9VHC */
export function formatSetupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** What a person typed → the stored form: upper-cased, dashes and whitespace removed. */
export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Constant-time comparison of a typed code with the stored one (hashing first
 * makes the lengths equal, which timingSafeEqual requires). */
export function setupCodeMatches(input: unknown, code: string): boolean {
  if (typeof input !== 'string') return false;
  const typed = crypto.createHash('sha256').update(normalizeSetupCode(input)).digest();
  const stored = crypto.createHash('sha256').update(code).digest();
  return crypto.timingSafeEqual(typed, stored);
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/setup-code.spec.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/onboarding/setup-code.ts ui/packages/server/src/onboarding/setup-code.spec.ts
git commit -m "feat(ui): setup code — 12 unambiguous characters, typed any way, compared in constant time"
git log --oneline -1
```

---
### Task 5: Onboarding store — the record, the admin password, start-up and reset

**Files:**
- Create: `ui/packages/server/src/onboarding/onboarding-store.ts`
- Create: `ui/packages/server/src/onboarding/onboarding-store.module.ts`
- Create: `ui/packages/server/test/fixtures/fake-kv.ts`
- Test: `ui/packages/server/src/onboarding/onboarding-store.spec.ts`

**Interfaces:**
- Consumes: `OpenBaoClient.readEntry`/`writeEntry`, `OpenBaoCasMismatchError`, `KvEntry` (Task 3); `generateSetupCode`, `formatSetupCode` (Task 4); `InstalledModule` exporting `OpenBaoClient` (Task 1).
- Produces:
  - `type StoredState = 'open' | 'claimed' | 'finished'`.
  - `interface OnboardingRecord { state: StoredState; code: string; generation: number; account: string | null; accountGeneration: number | null; createdAt: string; claimedAt: string | null; finishedAt: string | null }`.
  - `parseRecord(data: Record<string, unknown>): OnboardingRecord`: throws `/malformed/` on a bad record.
  - `const STORE_UNAVAILABLE = "LibrePod's secret store isn't reachable right now — try again in a minute."`
  - `class OnboardingStore` (`@Injectable`, `OnModuleInit`, `OnModuleDestroy`), with these methods:
    - `start(delayMs?: number): Promise<void>`
    - `record(): Promise<OnboardingRecord>`: cached for at most 5 s; creates the record when missing; throws when OpenBao can't answer.
    - `save(record: OnboardingRecord): Promise<void>`
    - `finishIfClaimed(signedInAtMs?: number): Promise<boolean>`
    - `reset(): Promise<string>`: returns the new code.
    - `adminPassword(): Promise<string | null>`
    - `saveAdminPassword(password: string): Promise<void>`
  - `OnboardingStoreModule`: imports `InstalledModule`, exports `OnboardingStore`.
  - `test/fixtures/fake-kv.ts` exports `class FakeKv` (`readEntry`, `writeEntry` with CAS, `get(mount, path)`, `failWith: Error | null`). Tasks 10 and 11 reuse it.

- [ ] **Step 1: Create the in-memory KV fixture**

Create `ui/packages/server/test/fixtures/fake-kv.ts`:

```ts
import { OpenBaoCasMismatchError, type KvEntry } from '../../src/installed/openbao.client';

/** In-memory KV v2 with check-and-set: the slice of OpenBaoClient the onboarding store uses. */
export class FakeKv {
  private readonly entries = new Map<string, KvEntry>();
  /** Set to make every call reject with this error (OpenBao down, sealed, misconfigured). */
  failWith: Error | null = null;

  async readEntry(mount: string, path: string): Promise<KvEntry | null> {
    if (this.failWith) throw this.failWith;
    const entry = this.entries.get(`${mount}/${path}`);
    return entry ? { data: structuredClone(entry.data), version: entry.version } : null;
  }

  async writeEntry(
    mount: string,
    path: string,
    data: Record<string, unknown>,
    opts: { cas?: number } = {},
  ): Promise<void> {
    if (this.failWith) throw this.failWith;
    const key = `${mount}/${path}`;
    const version = this.entries.get(key)?.version ?? 0;
    if (opts.cas !== undefined && opts.cas !== version) {
      throw new OpenBaoCasMismatchError(`write ${key}: the entry changed since it was read`);
    }
    this.entries.set(key, { data: structuredClone(data), version: version + 1 });
  }

  /** The stored data, for assertions. */
  get(mount: string, path: string): Record<string, unknown> | undefined {
    return this.entries.get(`${mount}/${path}`)?.data;
  }
}
```

- [ ] **Step 2: Write the failing store tests**

Create `ui/packages/server/src/onboarding/onboarding-store.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingStore } from './onboarding-store';
import { SETUP_CODE_ALPHABET, formatSetupCode } from './setup-code';
import { OpenBaoUnavailableError, type OpenBaoClient } from '../installed/openbao.client';
import { FakeKv } from '../../test/fixtures/fake-kv';

const RECORD = 'marketplace-ui/onboarding';

function makeStore(kv = new FakeKv(), env: Record<string, string> = {}) {
  return { store: new OnboardingStore(kv as unknown as OpenBaoClient, new ConfigService(env)), kv };
}

describe('OnboardingStore', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.BOOTSTRAP_MODE_OVERRIDE;
  });

  describe('the record', () => {
    it('is created on first use: open, a fresh 12-character code, generation 1', async () => {
      const { store, kv } = makeStore();
      const record = await store.record();
      expect(record).toMatchObject({
        state: 'open', generation: 1, account: null, accountGeneration: null, claimedAt: null, finishedAt: null,
      });
      expect(record.code).toMatch(new RegExp(`^[${SETUP_CODE_ALPHABET}]{12}$`));
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open', code: record.code, generation: 1 });
    });

    it('is created with check-and-set: when another pod creates it first, theirs wins', async () => {
      const kv = new FakeKv();
      const { store } = makeStore(kv);
      const theirs = {
        state: 'open', code: 'THEIRCODE234', generation: 1, account: null, accountGeneration: null,
        createdAt: '2026-10-14T09:00:00.000Z', claimedAt: null, finishedAt: null,
      };
      const read = kv.readEntry.bind(kv);
      // The other pod writes between our read (nothing yet) and our create.
      vi.spyOn(kv, 'readEntry').mockImplementationOnce(async (mount, path) => {
        const before = await read(mount, path);
        await kv.writeEntry(mount, path, theirs);
        return before;
      });
      expect((await store.record()).code).toBe('THEIRCODE234');
    });

    it('lives in the configured system mount', async () => {
      const { store, kv } = makeStore(new FakeKv(), { OPENBAO_SYSTEM_MOUNT: 'sys' });
      await store.record();
      expect(kv.get('sys', RECORD)).toBeDefined();
    });

    it('is cached for at most 5 seconds, so a reset from another process lands without a restart', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-14T10:00:00Z') });
      const kv = new FakeKv();
      const { store } = makeStore(kv);
      const first = await store.record();
      await kv.writeEntry('system', RECORD, { ...first, code: 'NEWCODE23456', generation: 2 });
      expect((await store.record()).generation).toBe(1);
      vi.advanceTimersByTime(5_001);
      expect((await store.record()).generation).toBe(2);
    });

    it('rejects while OpenBao cannot answer', async () => {
      const kv = new FakeKv();
      kv.failWith = new OpenBaoUnavailableError('sealed');
      await expect(makeStore(kv).store.record()).rejects.toThrow('sealed');
    });

    it('a malformed record is an error, never a guessed state', async () => {
      const kv = new FakeKv();
      await kv.writeEntry('system', RECORD, { state: 'bogus', code: 'X', generation: 1 });
      await expect(makeStore(kv).store.record()).rejects.toThrow(/malformed/);
    });
  });

  describe('start-up', () => {
    it('logs the setup code while open', async () => {
      const { store } = makeStore();
      await store.start();
      const { code } = await store.record();
      expect(log).toHaveBeenCalledWith(
        `LibrePod setup code: ${formatSetupCode(code)} — open http://<this device's IP> to set up`,
      );
    });

    it('logs it while claimed too, and never once finished', async () => {
      const kv = new FakeKv();
      const base = { code: '7KQMX3RT9VHC', generation: 1, account: null, accountGeneration: null, createdAt: 't', finishedAt: null };
      await kv.writeEntry('system', RECORD, { ...base, state: 'claimed', claimedAt: 'c' });
      await makeStore(kv).store.start();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('LibrePod setup code: 7KQM-X3RT-9VHC'));

      log.mockClear();
      const finished = new FakeKv();
      await finished.writeEntry('system', RECORD, { ...base, state: 'finished', claimedAt: 'c', finishedAt: 'f' });
      await makeStore(finished).store.start();
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('setup code'));
    });

    it('retries in the background while OpenBao is not ready, then logs the code', async () => {
      vi.useFakeTimers();
      const kv = new FakeKv();
      kv.failWith = new OpenBaoUnavailableError('sealed');
      const { store } = makeStore(kv);
      await store.start();
      expect(log).not.toHaveBeenCalled();
      kv.failWith = null;
      await vi.advanceTimersByTimeAsync(5_000);
      // the retried start() is a chain of awaits; waitFor keeps ticking until it logs
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('LibrePod setup code: ')));
      store.onModuleDestroy();
    });

    it('does nothing under BOOTSTRAP_MODE_OVERRIDE (Tier 1 has no system/ mount)', () => {
      process.env.BOOTSTRAP_MODE_OVERRIDE = 'finished';
      const kv = new FakeKv();
      const read = vi.spyOn(kv, 'readEntry');
      makeStore(kv).store.onModuleInit();
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('transitions', () => {
    it('save() writes the whole record and refreshes the cache', async () => {
      const { store, kv } = makeStore();
      const open = await store.record();
      await store.save({ ...open, state: 'claimed', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'claimed', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect((await store.record()).state).toBe('claimed');
    });

    it('finishIfClaimed() finishes a claimed record once, and is a no-op otherwise', async () => {
      const { store, kv } = makeStore();
      const open = await store.record();
      expect(await store.finishIfClaimed()).toBe(false);
      await store.save({ ...open, state: 'claimed', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect(await store.finishIfClaimed()).toBe(true);
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'finished', finishedAt: expect.any(String) });
      expect(await store.finishIfClaimed()).toBe(false);
    });

    it('only a sign-in since the claim finishes — an older session must not end a reopened wizard', async () => {
      const { store } = makeStore();
      const open = await store.record();
      const claimedAt = Date.parse('2026-10-14T10:00:00.000Z');
      await store.save({ ...open, state: 'claimed', claimedAt: new Date(claimedAt).toISOString() });
      expect(await store.finishIfClaimed(claimedAt - 1_000)).toBe(false);
      expect(await store.finishIfClaimed(claimedAt + 1_000)).toBe(true);
    });

    it('reset() reopens: a new code, open, generation + 1, the account kept, timestamps cleared', async () => {
      const { store, kv } = makeStore();
      const open = await store.record();
      await store.save({
        ...open, state: 'finished', account: 'alex', accountGeneration: 1, claimedAt: 'c', finishedAt: 'f',
      });
      const code = await store.reset();
      expect(code).not.toBe(open.code);
      expect(kv.get('system', RECORD)).toEqual({
        state: 'open', code, generation: 2, account: 'alex', accountGeneration: 1,
        createdAt: open.createdAt, claimedAt: null, finishedAt: null,
      });
      expect((await store.record()).generation).toBe(2);
    });

    it('reset() also repairs a missing or malformed record', async () => {
      const kv = new FakeKv();
      await kv.writeEntry('system', RECORD, { state: 'bogus' });
      const { store } = makeStore(kv);
      await store.reset();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open', generation: 1, account: null });
    });
  });

  describe('admin password (system/admin)', () => {
    it('is null until written, then the password', async () => {
      const { store, kv } = makeStore();
      expect(await store.adminPassword()).toBeNull();
      await store.saveAdminPassword('correct-horse-12');
      expect(kv.get('system', 'admin')).toEqual({ password: 'correct-horse-12' });
      expect(await store.adminPassword()).toBe('correct-horse-12');
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/onboarding-store.spec.ts
```
Expected: FAIL, because `./onboarding-store` does not exist.

- [ ] **Step 4: Implement the store**

Create `ui/packages/server/src/onboarding/onboarding-store.ts`:

```ts
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenBaoCasMismatchError, OpenBaoClient } from '../installed/openbao.client';
import { formatSetupCode, generateSetupCode } from './setup-code';

export type StoredState = 'open' | 'claimed' | 'finished';

/** system/marketplace-ui/onboarding. `accountGeneration` is the generation in which
 * the Account step last ran: a reset keeps `account` (so the wizard can offer "keep
 * alex") but the step runs again after every claim. */
export interface OnboardingRecord {
  state: StoredState;
  code: string;
  generation: number;
  account: string | null;
  accountGeneration: number | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}

export const STORE_UNAVAILABLE = "LibrePod's secret store isn't reachable right now — try again in a minute.";

const RECORD_PATH = 'marketplace-ui/onboarding';
const ADMIN_PATH = 'admin';
/** reset-onboarding is another process: the server sees its write within this. */
const CACHE_TTL_MS = 5_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const STATES: readonly StoredState[] = ['open', 'claimed', 'finished'];

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function parseRecord(data: Record<string, unknown>): OnboardingRecord {
  const state = data.state as StoredState;
  const code = text(data.code);
  const generation = count(data.generation);
  if (!STATES.includes(state) || !code || generation === null) {
    throw new Error('the onboarding record is malformed — run reset-onboarding');
  }
  return {
    state,
    code,
    generation,
    account: text(data.account),
    accountGeneration: count(data.accountGeneration),
    createdAt: text(data.createdAt) ?? '',
    claimedAt: text(data.claimedAt),
    finishedAt: text(data.finishedAt),
  };
}

/**
 * First-run onboarding state in OpenBao `system/` (spec §6–§7): the onboarding
 * record, and the admin password stored readable by design (LibrePod is a trusted
 * perimeter). The record is created on first start with check-and-set, and the
 * setup code is logged on every start until onboarding finishes.
 */
@Injectable()
export class OnboardingStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardingStore.name);
  private cached?: { record: OnboardingRecord; at: number };
  private retry?: NodeJS.Timeout;

  constructor(
    private readonly bao: OpenBaoClient,
    private readonly config: ConfigService,
  ) {}

  private get mount(): string {
    return this.config.get<string>('OPENBAO_SYSTEM_MOUNT', 'system');
  }

  onModuleInit(): void {
    // Tier 1 forces the state and its dev-mode OpenBao has no system/ mount.
    if (process.env.BOOTSTRAP_MODE_OVERRIDE) return;
    void this.start();
  }

  onModuleDestroy(): void {
    clearTimeout(this.retry);
  }

  /** Ensures the record exists and logs the setup code; retries in the background
   * (backing off to a minute) while OpenBao is not ready. */
  async start(delayMs = RETRY_MIN_MS): Promise<void> {
    try {
      const record = await this.ensure();
      if (record.state !== 'finished') {
        this.logger.log(
          `LibrePod setup code: ${formatSetupCode(record.code)} — open http://<this device's IP> to set up`,
        );
      }
    } catch (err) {
      this.logger.warn(`onboarding record not ready (${(err as Error).message}); retrying in ${delayMs / 1000}s`);
      this.retry = setTimeout(() => void this.start(Math.min(delayMs * 2, RETRY_MAX_MS)), delayMs);
      this.retry.unref();
    }
  }

  /** The current record, at most CACHE_TTL_MS old. Throws when OpenBao can't answer. */
  async record(): Promise<OnboardingRecord> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.record;
    return this.ensure();
  }

  async save(record: OnboardingRecord): Promise<void> {
    await this.bao.writeEntry(this.mount, RECORD_PATH, { ...record });
    this.remember(record);
  }

  /** The SSO callback's hook (spec §8): the first sign-in since the claim finishes
   * onboarding. A session from before a reset must not end the reopened wizard, so
   * the sign-in has to be at or after `claimedAt`. */
  async finishIfClaimed(signedInAtMs = Date.now()): Promise<boolean> {
    const record = await this.record();
    if (record.state !== 'claimed') return false;
    if (record.claimedAt && signedInAtMs < Date.parse(record.claimedAt)) return false;
    await this.save({ ...record, state: 'finished', finishedAt: new Date().toISOString() });
    this.logger.log('onboarding finished: first single sign-on since the claim');
    return true;
  }

  /** `reset-onboarding` (spec §6): a new code, state open, generation + 1. Keeps the
   * account; clears claimedAt/finishedAt. Also repairs a missing or malformed record. */
  async reset(): Promise<string> {
    const old = (await this.bao.readEntry(this.mount, RECORD_PATH))?.data ?? {};
    const record: OnboardingRecord = {
      state: 'open',
      code: generateSetupCode(),
      generation: (count(old.generation) ?? 0) + 1,
      account: text(old.account),
      accountGeneration: count(old.accountGeneration),
      createdAt: text(old.createdAt) ?? new Date().toISOString(),
      claimedAt: null,
      finishedAt: null,
    };
    await this.save(record);
    return record.code;
  }

  async adminPassword(): Promise<string | null> {
    const password = (await this.bao.readEntry(this.mount, ADMIN_PATH))?.data.password;
    return typeof password === 'string' && password !== '' ? password : null;
  }

  async saveAdminPassword(password: string): Promise<void> {
    await this.bao.writeEntry(this.mount, ADMIN_PATH, { password });
  }

  /** Reads the record, creating it when missing: open, a fresh code, generation 1.
   * Check-and-set (cas 0), so two pods starting together cannot both create a code. */
  private async ensure(): Promise<OnboardingRecord> {
    const existing = await this.read();
    if (existing) return existing;
    const now = new Date().toISOString();
    const fresh: OnboardingRecord = {
      state: 'open', code: generateSetupCode(), generation: 1, account: null, accountGeneration: null,
      createdAt: now, claimedAt: null, finishedAt: null,
    };
    try {
      await this.bao.writeEntry(this.mount, RECORD_PATH, { ...fresh }, { cas: 0 });
    } catch (err) {
      if (!(err instanceof OpenBaoCasMismatchError)) throw err;
      const winner = await this.read();
      if (!winner) throw err;
      return winner;
    }
    this.remember(fresh);
    return fresh;
  }

  private async read(): Promise<OnboardingRecord | null> {
    const entry = await this.bao.readEntry(this.mount, RECORD_PATH);
    if (!entry) return null;
    const record = parseRecord(entry.data);
    this.remember(record);
    return record;
  }

  private remember(record: OnboardingRecord): void {
    this.cached = { record, at: Date.now() };
  }
}
```

- [ ] **Step 5: Implement the module**

Create `ui/packages/server/src/onboarding/onboarding-store.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { InstalledModule } from '../installed/installed.module';
import { OnboardingStore } from './onboarding-store';

/** Its own module so AuthModule (the SSO callback's finish hook) and OnboardingModule
 * (which imports AuthModule for SessionService) share one store without a cycle. */
@Module({
  // InstalledModule exports OpenBaoClient: one client, one cached OpenBao login.
  imports: [InstalledModule],
  providers: [OnboardingStore],
  exports: [OnboardingStore],
})
export class OnboardingStoreModule {}
```

- [ ] **Step 6: Run to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
```
Expected: PASS (16 store tests plus the setup-code tests); tsc exits 0.

- [ ] **Step 7: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/onboarding/onboarding-store.ts ui/packages/server/src/onboarding/onboarding-store.module.ts ui/packages/server/src/onboarding/onboarding-store.spec.ts ui/packages/server/test/fixtures/fake-kv.ts
git commit -m "feat(ui): onboarding record in OpenBao system/ — created with check-and-set, setup code logged until finished, reset"
git log --oneline -1
```

---
### Task 6: OpenBao policy — marketplace-ui may use `system/marketplace-ui/*` and `system/admin`

**Files:**
- Create: `apps/openbao/overlays/librepod/policies/marketplace-ui-system.hcl`
- Modify: `apps/openbao/overlays/librepod/kustomization.yaml`, `apps/openbao/components/bootstrap/bootstrap.sh`, `apps/openbao/components/bootstrap/job.yaml`, `apps/openbao/README.md`
- Test: `ui/packages/server/src/onboarding/openbao-policy.spec.ts`

**Interfaces:**
- Consumes: the store's paths from Task 5 (`system/marketplace-ui/onboarding`, `system/admin`).
- Produces: OpenBao role `marketplace-ui` with policies `marketplace-ui-write-apps,marketplace-ui-system`; the bootstrap Job's `openbao.librepod/policies-version` set to `"6"`.

- [ ] **Step 1: Write the failing contract test**

Create `ui/packages/server/src/onboarding/openbao-policy.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OnboardingStore reads and writes system/marketplace-ui/onboarding and
 * system/admin. Without these grants every read is a 403 and the device sits on
 * "waking up" forever, so the policy is pinned to the store's paths here. The
 * openbao app lives five levels up from packages/server/src/onboarding.
 */
const OPENBAO = join(__dirname, '../../../../../apps/openbao');
const read = (path: string) => readFileSync(join(OPENBAO, path), 'utf8');

function capabilities(policy: string, path: string): string[] {
  const block = policy.match(new RegExp(`path "${path.replace(/\*/g, '\\*')}"\\s*\\{([^}]*)\\}`));
  return block ? [...block[1].matchAll(/"(\w+)"/g)].map((m) => m[1]) : [];
}

describe('marketplace-ui access to OpenBao system/', () => {
  const policy = read('overlays/librepod/policies/marketplace-ui-system.hcl');

  it.each(['system/data/marketplace-ui/*', 'system/data/admin'])('%s: create, update and read', (path) => {
    expect(capabilities(policy, path)).toEqual(expect.arrayContaining(['create', 'update', 'read']));
  });

  it('the policy file is mounted into the bootstrap Job', () => {
    expect(read('overlays/librepod/kustomization.yaml')).toContain(
      'marketplace-ui-system.hcl=policies/marketplace-ui-system.hcl',
    );
  });

  it('the marketplace-ui role carries it', () => {
    expect(read('components/bootstrap/bootstrap.sh')).toMatch(
      /role\/marketplace-ui \\[\s\S]*?policies=marketplace-ui-write-apps,marketplace-ui-system /,
    );
  });

  it('the bootstrap Job re-runs to apply it', () => {
    expect(read('components/bootstrap/job.yaml')).toContain('openbao.librepod/policies-version: "6"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/openbao-policy.spec.ts
```
Expected: FAIL with ENOENT on `marketplace-ui-system.hcl`.

- [ ] **Step 3: Add the policy**

Create `apps/openbao/overlays/librepod/policies/marketplace-ui-system.hcl`:

```hcl
# marketplace-ui: first-run onboarding state in system/ (regular apps never see
# system/ — eso-read-apps reads apps/* only).
#   system/marketplace-ui/*  the onboarding record: state, setup code, generation
#   system/admin             the admin password, stored readable by design
#                            (LibrePod is a trusted perimeter)
path "system/data/marketplace-ui/*" {
  capabilities = ["create", "update", "read"]
}

path "system/data/admin" {
  capabilities = ["create", "update", "read"]
}
```

- [ ] **Step 4: Mount it, attach it, re-run the Job**

In `apps/openbao/overlays/librepod/kustomization.yaml`, add after the `marketplace-ui-write-apps.hcl=…` line:

```yaml
      - marketplace-ui-system.hcl=policies/marketplace-ui-system.hcl
```

In `apps/openbao/components/bootstrap/bootstrap.sh`, change the marketplace-ui role's policies line from

```sh
  policies=marketplace-ui-write-apps ttl=20m
```

to

```sh
  policies=marketplace-ui-write-apps,marketplace-ui-system ttl=20m
```

and add above `bao write auth/kubernetes/role/marketplace-ui \` the comment:

```sh
# marketplace-ui: app settings under apps/ (marketplace-ui-write-apps) and
# first-run onboarding state under system/ (marketplace-ui-system — the
# onboarding record and the admin password).
```

In `apps/openbao/components/bootstrap/job.yaml`, change `openbao.librepod/policies-version: "5"` to `openbao.librepod/policies-version: "6"`.

In `apps/openbao/README.md`, replace

```markdown
   - `marketplace-ui-write-apps` ← role `marketplace-ui`
     (SA `marketplace-ui`, ns `marketplace-ui`): **create/update** `apps/*`
```

with

```markdown
   - `marketplace-ui-write-apps` + `marketplace-ui-system` ← role
     `marketplace-ui` (SA `marketplace-ui`, ns `marketplace-ui`):
     **create/update** `apps/*`, and **create/update/read**
     `system/marketplace-ui/*` (the first-run onboarding record) and
     `system/admin` (the admin password)
```

- [ ] **Step 5: Run the test and the manifest check**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/openbao-policy.spec.ts
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code && kustomize build apps/openbao/overlays/librepod | grep -c 'marketplace-ui-system' && kustomize build apps/openbao/overlays/librepod | kubeconform -strict -summary -ignore-missing-schemas -schema-location default
```
Expected:
- PASS (5 tests).
- grep counts at least 1.
- kubeconform reports `Invalid: 0, Errors: 0`.

- [ ] **Step 6: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add apps/openbao/overlays/librepod/policies/marketplace-ui-system.hcl apps/openbao/overlays/librepod/kustomization.yaml apps/openbao/components/bootstrap/bootstrap.sh apps/openbao/components/bootstrap/job.yaml apps/openbao/README.md ui/packages/server/src/onboarding/openbao-policy.spec.ts
git commit -m "feat(openbao): marketplace-ui may keep the onboarding record and the admin password in system/"
git log --oneline -1
```

---

### Task 7: Casdoor admin service — the built-in admin's API

**Files:**
- Create: `ui/packages/server/src/onboarding/casdoor-admin.service.ts`
- Test: `ui/packages/server/src/onboarding/casdoor-admin.service.spec.ts`

Do **not** carry #215's version of these files. Its factory-login probe and `claim()` are retired.

**Interfaces:**
- Produces:
  - `interface CasdoorSession { cookie: string; password: string }`.
  - `class CasdoorAdminService` (`@Injectable`). It reads `CASDOOR_BASE_URL`, `CASDOOR_ORG_NAME` (default `librepod`) and `BASE_DOMAIN` (default `libre.pod`) at construction, and `CASDOOR_ADMIN_DEFAULT_PASSWORD` (default `123`) through the getter.
  - Methods:
    - `get factoryPassword(): string`
    - `reachable(): Promise<boolean>`: `GET /.well-known/openid-configuration`.
    - `signIn(candidates: string[]): Promise<CasdoorSession | null>`: tries each non-empty, distinct candidate in order; returns null if all are rejected. Throws 503 on network/5xx/non-JSON.
    - `setAdminPassword(session: CasdoorSession, newPassword: string): Promise<void>`
    - `ensureOrganization(session: CasdoorSession): Promise<void>`
    - `getUser(session: CasdoorSession, name: string): Promise<{ name: string } | null>`
    - `addUser(session: CasdoorSession, name: string, password: string): Promise<void>`
    - `setUserPassword(session: CasdoorSession, name: string, newPassword: string): Promise<void>`
  - A Casdoor `status: 'error'` answer on an admin call becomes `BadGatewayException('Casdoor refused <path>: <msg>')`.

- [ ] **Step 1: Write the failing tests**

Create `ui/packages/server/src/onboarding/casdoor-admin.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { CasdoorAdminService, type CasdoorSession } from './casdoor-admin.service';

function jsonRes(body: unknown, opts: { status?: number; setCookie?: string[] } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  (opts.setCookie ?? []).forEach((c) => headers.append('set-cookie', c));
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers });
}

interface Call { url: string; method: string; body?: string; cookie?: string }
function recordFetch(answer: (url: string, body?: string) => Response) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body == null ? undefined : String(init.body);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url).replace('http://casdoor.test', ''), method: init?.method ?? 'GET', body, cookie: headers.cookie });
    return answer(String(url), body);
  });
  return calls;
}

const session: CasdoorSession = { cookie: 'casdoor_session_id=abc', password: 'admin-password-12' };

describe('CasdoorAdminService', () => {
  beforeEach(() => {
    process.env.CASDOOR_BASE_URL = 'http://casdoor.test';
    process.env.CASDOOR_ORG_NAME = 'librepod';
    process.env.BASE_DOMAIN = 'libre.pod';
    delete process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD;
  });
  afterEach(() => vi.restoreAllMocks());

  it('factoryPassword defaults to Casdoor\'s "123" and follows CASDOOR_ADMIN_DEFAULT_PASSWORD', () => {
    expect(new CasdoorAdminService().factoryPassword).toBe('123');
    process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD = 'factory';
    expect(new CasdoorAdminService().factoryPassword).toBe('factory');
  });

  describe('reachable', () => {
    it('is true when OIDC discovery answers JSON', async () => {
      const calls = recordFetch(() => jsonRes({ issuer: 'https://id.libre.pod' }));
      expect(await new CasdoorAdminService().reachable()).toBe(true);
      expect(calls[0].url).toBe('/.well-known/openid-configuration');
    });

    it('is false on a network error, an error page, or no base URL', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      expect(await new CasdoorAdminService().reachable()).toBe(false);
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
      expect(await new CasdoorAdminService().reachable()).toBe(false);
      delete process.env.CASDOOR_BASE_URL;
      expect(await new CasdoorAdminService().reachable()).toBe(false);
    });
  });

  describe('signIn', () => {
    it('tries the candidates in order, skipping empty and repeated ones, and keeps only name=value cookies', async () => {
      const calls = recordFetch((_url, body) =>
        JSON.parse(body!).password === 'new-password-12'
          ? jsonRes({ status: 'ok' }, { setCookie: ['casdoor_session_id=abc; Path=/; HttpOnly'] })
          : jsonRes({ status: 'error', msg: 'password or code is incorrect' }),
      );
      const result = await new CasdoorAdminService().signIn(['', '123', '123', 'new-password-12']);
      expect(result).toEqual({ cookie: 'casdoor_session_id=abc', password: 'new-password-12' });
      expect(calls.map((c) => JSON.parse(c.body!).password)).toEqual(['123', 'new-password-12']);
      expect(JSON.parse(calls[0].body!)).toMatchObject({
        type: 'login', application: 'app-built-in', organization: 'built-in', username: 'admin',
      });
    });

    it('is null when Casdoor rejects every candidate', async () => {
      recordFetch(() => jsonRes({ status: 'error', msg: 'password or code is incorrect' }));
      expect(await new CasdoorAdminService().signIn(['a-password-123', 'b-password-123'])).toBeNull();
    });

    it('a down or erroring Casdoor is a 503 — never "wrong password"', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(new CasdoorAdminService().signIn(['123'])).rejects.toThrow(ServiceUnavailableException);
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(jsonRes({ status: 'error', msg: 'db' }, { status: 500 }));
      await expect(new CasdoorAdminService().signIn(['123'])).rejects.toThrow(ServiceUnavailableException);
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));
      await expect(new CasdoorAdminService().signIn(['123'])).rejects.toThrow(ServiceUnavailableException);
    });
  });

  it('setAdminPassword posts the form set-password accepts, with the session cookie', async () => {
    const calls = recordFetch(() => jsonRes({ status: 'ok' }));
    await new CasdoorAdminService().setAdminPassword(session, 'new-password-12');
    expect(calls[0]).toMatchObject({ url: '/api/set-password', method: 'POST', cookie: 'casdoor_session_id=abc' });
    const form = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(form)).toEqual({
      userOwner: 'built-in', userName: 'admin', oldPassword: 'admin-password-12', newPassword: 'new-password-12',
    });
  });

  describe('ensureOrganization', () => {
    it('does nothing when the platform org exists (looked up as admin/<org>)', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'ok', data: { name: 'librepod' } }));
      await new CasdoorAdminService().ensureOrganization(session);
      expect(calls.map((c) => c.url)).toEqual(['/api/get-organization?id=admin/librepod']);
    });

    it('creates it when missing', async () => {
      const calls = recordFetch((url) =>
        url.includes('get-organization') ? jsonRes({ status: 'ok', data: null }) : jsonRes({ status: 'ok' }),
      );
      await new CasdoorAdminService().ensureOrganization(session);
      expect(calls[1].url).toBe('/api/add-organization');
      expect(JSON.parse(calls[1].body!)).toMatchObject({ owner: 'admin', name: 'librepod' });
    });

    it('an error answer is surfaced, not mistaken for "missing"', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'error', msg: 'wrong id format' }));
      await expect(new CasdoorAdminService().ensureOrganization(session)).rejects.toThrow(BadGatewayException);
      expect(calls).toHaveLength(1);
    });
  });

  describe('platform-org users', () => {
    it('getUser returns the user or null', async () => {
      const calls = recordFetch((url) =>
        url.endsWith('/alex') ? jsonRes({ status: 'ok', data: { name: 'alex' } }) : jsonRes({ status: 'ok', data: null }),
      );
      const svc = new CasdoorAdminService();
      expect(await svc.getUser(session, 'alex')).toMatchObject({ name: 'alex' });
      expect(await svc.getUser(session, 'bob')).toBeNull();
      expect(calls[0].url).toBe('/api/get-user?id=librepod/alex');
    });

    it('addUser creates <name>@<base-domain> as an admin of the platform org', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'ok' }));
      await new CasdoorAdminService().addUser(session, 'alex', 'personal-pass-12');
      expect(calls[0].url).toBe('/api/add-user');
      expect(JSON.parse(calls[0].body!)).toMatchObject({
        owner: 'librepod', name: 'alex', email: 'alex@libre.pod', password: 'personal-pass-12', isAdmin: true,
      });
    });

    it('setUserPassword needs no old password (the caller is Casdoor\'s admin)', async () => {
      const calls = recordFetch(() => jsonRes({ status: 'ok' }));
      await new CasdoorAdminService().setUserPassword(session, 'alex', 'brand-new-pass-12');
      expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
        userOwner: 'librepod', userName: 'alex', oldPassword: '', newPassword: 'brand-new-pass-12',
      });
    });

    it("a refused call carries Casdoor's reason", async () => {
      recordFetch(() => jsonRes({ status: 'error', msg: 'the user already exists' }));
      await expect(new CasdoorAdminService().addUser(session, 'alex', 'personal-pass-12')).rejects.toThrow(
        /Casdoor refused \/api\/add-user: the user already exists/,
      );
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/casdoor-admin.service.spec.ts
```
Expected: FAIL, because `./casdoor-admin.service` does not exist.

- [ ] **Step 3: Implement**

Create `ui/packages/server/src/onboarding/casdoor-admin.service.ts`:

```ts
import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';

interface CasdoorResponse {
  status: string;
  msg?: string;
  data?: unknown;
}

/** A signed-in built-in admin: the session cookie and the password that opened it. */
export interface CasdoorSession {
  cookie: string;
  password: string;
}

/** Upper bound on one Casdoor call: a hung Casdoor must not hang the wizard. */
const TIMEOUT_MS = 10_000;

/**
 * Casdoor's admin API as the built-in admin — Casdoor's superuser, LibrePod's
 * `admin`. Casdoor v3.106 accepts only its own beego session cookie on
 * /api/set-password, so every operation starts with signIn() (POST /api/login,
 * the login page's anonymous endpoint) and replays the cookie it returns.
 * Casdoor answering 5xx or non-JSON means "down" (503), never "wrong password".
 */
@Injectable()
export class CasdoorAdminService {
  private readonly baseUrl = (process.env.CASDOOR_BASE_URL ?? '').replace(/\/$/, '');
  private readonly org = process.env.CASDOOR_ORG_NAME ?? 'librepod';
  private readonly baseDomain = process.env.BASE_DOMAIN ?? 'libre.pod';

  /** Casdoor's factory admin password; the casdoor-sso-controller env carries the same value. */
  get factoryPassword(): string {
    return process.env.CASDOOR_ADMIN_DEFAULT_PASSWORD ?? '123';
  }

  /** Up and answering. OIDC discovery is unauthenticated JSON and cheap. */
  async reachable(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return res.ok && (await res.json().catch(() => null)) !== null;
    } catch {
      return false;
    }
  }

  /** Signs in as the built-in admin with the first candidate Casdoor accepts, in
   * order; empty and repeated candidates are skipped. null = all rejected. */
  async signIn(candidates: string[]): Promise<CasdoorSession | null> {
    for (const password of [...new Set(candidates)].filter((p) => p !== '')) {
      const res = await this.request('/api/login', {
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
      const json = await this.parse(res, '/api/login');
      if (json.status === 'ok') {
        const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
        return { cookie, password };
      }
    }
    return null;
  }

  async setAdminPassword(session: CasdoorSession, newPassword: string): Promise<void> {
    await this.setPassword(session, 'built-in', 'admin', session.password, newPassword);
  }

  /** The platform org. casdoor-sso-controller normally creates it; creating it here
   * means a slow controller can never wedge a claim. Organizations belong to "admin". */
  async ensureOrganization(session: CasdoorSession): Promise<void> {
    if (await this.getJson(session, `/api/get-organization?id=admin/${encodeURIComponent(this.org)}`)) return;
    await this.postJson(session, '/api/add-organization', { owner: 'admin', name: this.org, displayName: 'LibrePod' });
  }

  async getUser(session: CasdoorSession, name: string): Promise<{ name: string } | null> {
    const id = `${encodeURIComponent(this.org)}/${encodeURIComponent(name)}`;
    return (await this.getJson(session, `/api/get-user?id=${id}`)) as { name: string } | null;
  }

  /** A personal user, `<name>@<base-domain>`: admin of the platform org, not of Casdoor. */
  async addUser(session: CasdoorSession, name: string, password: string): Promise<void> {
    await this.postJson(session, '/api/add-user', {
      owner: this.org,
      name,
      displayName: name,
      email: `${name}@${this.baseDomain}`,
      password,
      isAdmin: true,
      type: 'normal-user',
    });
  }

  /** Casdoor's admin needs no old password to set another user's. */
  async setUserPassword(session: CasdoorSession, name: string, newPassword: string): Promise<void> {
    await this.setPassword(session, this.org, name, '', newPassword);
  }

  private async setPassword(
    session: CasdoorSession,
    userOwner: string,
    userName: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const res = await this.request('/api/set-password', {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userOwner, userName, oldPassword, newPassword }),
    });
    this.expectOk(await this.parse(res, '/api/set-password'), '/api/set-password');
  }

  private async getJson(session: CasdoorSession, path: string): Promise<unknown> {
    const json = await this.parse(await this.request(path, { headers: { cookie: session.cookie } }), path);
    this.expectOk(json, path);
    return json.data ?? null;
  }

  private async postJson(session: CasdoorSession, path: string, payload: unknown): Promise<void> {
    const res = await this.request(path, {
      method: 'POST',
      headers: { cookie: session.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    this.expectOk(await this.parse(res, path), path);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    if (!this.baseUrl) throw new ServiceUnavailableException('Casdoor is not configured (CASDOOR_BASE_URL).');
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ServiceUnavailableException("Single sign-on (Casdoor) isn't reachable yet — try again in a minute.");
    }
  }

  private async parse(res: Response, path: string): Promise<CasdoorResponse> {
    const json = (await res.json().catch(() => null)) as CasdoorResponse | null;
    if (!res.ok || !json) {
      throw new ServiceUnavailableException(`Casdoor ${path} answered HTTP ${res.status} — try again in a minute.`);
    }
    return json;
  }

  private expectOk(json: CasdoorResponse, path: string): void {
    if (json.status !== 'ok') throw new BadGatewayException(`Casdoor refused ${path}: ${json.msg ?? 'no reason given'}`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/casdoor-admin.service.spec.ts && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
```
Expected: PASS (14 tests); tsc exits 0.

- [ ] **Step 5: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/onboarding/casdoor-admin.service.ts ui/packages/server/src/onboarding/casdoor-admin.service.spec.ts
git commit -m "feat(ui): Casdoor admin service — sign in as the built-in admin, set passwords, manage platform-org users"
git log --oneline -1
```

---
### Task 8: Sessions — AuthGuard exemption, generation-bound onboarding cookie, SSO finish hook

**Files:**
- Modify (carry, then edit): `ui/packages/server/src/auth/auth.guard.ts`
- Create (carry): `ui/packages/server/src/auth/auth.guard.spec.ts`
- Modify: `ui/packages/server/src/auth/auth.types.ts`, `ui/packages/server/src/auth/auth.controller.ts`, `ui/packages/server/src/auth/auth.module.ts`
- Create: `ui/packages/server/src/onboarding/onboarding.guard.ts`
- Test: `ui/packages/server/src/onboarding/onboarding.guard.spec.ts`, `ui/packages/server/src/auth/auth.controller.spec.ts`

**Interfaces:**
- Consumes: `OnboardingStore.record()`, `finishIfClaimed()`, `OnboardingRecord`, `STORE_UNAVAILABLE`, `OnboardingStoreModule` (Task 5).
- Produces:
  - `SessionClaims` gains `generation?: number`.
  - `ONBOARDING_COOKIE = 'mp_onboarding'`.
  - `isOnboardingSession(session: SessionService, token: string | undefined, record: OnboardingRecord): boolean`.
  - `OnboardingGuard` (async):
    - 401 for a missing or invalid cookie, the wrong generation, or a state other than `claimed`.
    - 503 (`STORE_UNAVAILABLE`) when OpenBao can't answer.
  - `AuthGuard` exempts `/api/bootstrap/` and rejects `sub === 'onboarding'`.
  - `AuthController.callback` calls `OnboardingStore.finishIfClaimed()` after a successful sign-in and never fails the sign-in because of it.
  - `AuthModule` imports `OnboardingStoreModule`.

- [ ] **Step 1: Carry #215's AuthGuard change and its spec**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git diff db77265 b42337c -- ui/packages/server/src/auth/auth.guard.ts ui/packages/server/src/auth/auth.guard.spec.ts | git apply --3way
```

Then in `ui/packages/server/src/auth/auth.guard.ts` replace the comment

```ts
    // sub === 'onboarding' is the wizard's mp_onboarding token, signed with
    // the same HMAC — it must never authenticate as a session (its holder
    // only proved presence while the factory window was open).
```

with

```ts
    // sub === 'onboarding' is the wizard's mp_onboarding token, signed with
    // the same HMAC — it must never authenticate as a session (it only proves
    // the setup code was entered).
```

and in the `isPublic` doc comment replace `The\n   * wizard's WireGuard endpoints carry their own mp_onboarding-cookie guard.` with `The\n   * wizard's cookie-gated endpoints carry their own OnboardingGuard.` (keep the line wrapping of the surrounding comment).

- [ ] **Step 2: Add `generation` to the claims type**

Replace the contents of `ui/packages/server/src/auth/auth.types.ts` with:

```ts
import type { User } from '@librepod/shared';

/** `generation` is set only on the onboarding cookie: the onboarding record's
 * generation it was issued for, so a reset retires every older cookie. */
export type SessionClaims = User & { iat: number; exp: number; generation?: number };
```

- [ ] **Step 3: Write the failing guard test**

Create `ui/packages/server/src/onboarding/onboarding.guard.spec.ts`:

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../auth/session.service';
import { OnboardingGuard, isOnboardingSession } from './onboarding.guard';
import type { OnboardingRecord, OnboardingStore } from './onboarding-store';

const claimed: OnboardingRecord = {
  state: 'claimed', code: '7KQMX3RT9VHC', generation: 3, account: null, accountGeneration: null,
  createdAt: 't', claimedAt: 'c', finishedAt: null,
};

let session: SessionService;
beforeAll(() => {
  process.env.SESSION_SECRET = 'onboarding-guard-spec';
  session = new SessionService();
});

const token = (claims: { sub: string; generation?: number }) =>
  session.sign({ name: claims.sub, email: '', ...claims });

function guardWith(record: OnboardingRecord | Error) {
  const store = {
    record: vi.fn(async () => {
      if (record instanceof Error) throw record;
      return record;
    }),
  };
  return { guard: new OnboardingGuard(session, store as unknown as OnboardingStore), store };
}

const ctx = (cookie?: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ cookies: cookie ? { mp_onboarding: cookie } : {} }) }),
  }) as never;

describe('OnboardingGuard', () => {
  it('admits the cookie for the current generation while the device is claimed', async () => {
    const { guard } = guardWith(claimed);
    await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 3 })))).resolves.toBe(true);
  });

  it('a missing or forged cookie is a 401 without asking OpenBao', async () => {
    const { guard, store } = guardWith(claimed);
    await expect(guard.canActivate(ctx())).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(ctx('forged.token'))).rejects.toThrow(UnauthorizedException);
    expect(store.record).not.toHaveBeenCalled();
  });

  it('a cookie from before a reset (older generation) is refused', async () => {
    const { guard } = guardWith(claimed);
    await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 2 })))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('nothing is admitted once finished, or while open', async () => {
    for (const state of ['finished', 'open'] as const) {
      const { guard } = guardWith({ ...claimed, state });
      await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 3 })))).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('an SSO session token in the onboarding cookie is refused', async () => {
    const { guard } = guardWith(claimed);
    await expect(guard.canActivate(ctx(token({ sub: 'alex', generation: 3 })))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('OpenBao unreachable fails closed with a 503', async () => {
    const { guard } = guardWith(new Error('sealed'));
    await expect(guard.canActivate(ctx(token({ sub: 'onboarding', generation: 3 })))).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('isOnboardingSession is the same predicate, for status', () => {
    expect(isOnboardingSession(session, token({ sub: 'onboarding', generation: 3 }), claimed)).toBe(true);
    expect(isOnboardingSession(session, token({ sub: 'onboarding' }), claimed)).toBe(false);
    expect(isOnboardingSession(session, undefined, claimed)).toBe(false);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/onboarding.guard.spec.ts
```
Expected: FAIL, because `./onboarding.guard` does not exist.

- [ ] **Step 5: Implement the guard**

Create `ui/packages/server/src/onboarding/onboarding.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionService } from '../auth/session.service';
import { OnboardingStore, STORE_UNAVAILABLE, type OnboardingRecord } from './onboarding-store';

export const ONBOARDING_COOKIE = 'mp_onboarding';

/** A valid onboarding cookie for the record's current generation, while it is claimed.
 * A cookie from before a reset, or any cookie once onboarding finished, is not one. */
export function isOnboardingSession(
  session: SessionService,
  token: string | undefined,
  record: OnboardingRecord,
): boolean {
  const claims = session.verify(token);
  return (
    !!claims && claims.sub === 'onboarding' && record.state === 'claimed' && claims.generation === record.generation
  );
}

/**
 * Gates the wizard's account, VPN install and WireGuard endpoints. The cookie is set
 * only by the claim and by resume (both need the setup code); it is bound to the
 * record's generation, so `reset-onboarding` retires every cookie issued before it.
 * Fails closed: no answer from OpenBao is a 503.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(
    private readonly session: SessionService,
    private readonly store: OnboardingStore,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ cookies?: Record<string, string> }>();
    const token = req.cookies?.[ONBOARDING_COOKIE];
    // A forged or expired cookie is refused before OpenBao is asked anything.
    if (!this.session.verify(token)) throw new UnauthorizedException();
    let record: OnboardingRecord;
    try {
      record = await this.store.record();
    } catch {
      throw new ServiceUnavailableException(STORE_UNAVAILABLE);
    }
    if (!isOnboardingSession(this.session, token, record)) throw new UnauthorizedException();
    return true;
  }
}
```

- [ ] **Step 6: Run the guard tests**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/onboarding.guard.spec.ts src/auth
```
Expected: PASS (7 guard tests plus the carried `AuthGuard` tests and the existing auth tests).

- [ ] **Step 7: Write the failing callback test**

Create `ui/packages/server/src/auth/auth.controller.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import type { CasdoorService } from './casdoor.service';
import type { SessionService } from './session.service';
import type { OnboardingStore } from '../onboarding/onboarding-store';

function make(finishIfClaimed = vi.fn(async () => true)) {
  const casdoor = {
    exchangeCode: vi.fn(async () => ({ sub: 'alex', name: 'alex', email: 'alex@libre.pod' })),
  } as unknown as CasdoorService;
  const session = {
    sign: vi.fn(() => 'session-token'),
    cookieName: 'mp_session',
    ttlSeconds: 60,
  } as unknown as SessionService;
  const store = { finishIfClaimed } as unknown as OnboardingStore;
  return { controller: new AuthController(casdoor, session, store), finishIfClaimed };
}

function fakeRes() {
  return { cookie: vi.fn(), clearCookie: vi.fn(), redirect: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };
}

const req = { cookies: { mp_oauth_state: 'state-1' }, headers: { 'x-forwarded-host': 'libre.pod' } } as unknown as Request;

describe('AuthController.callback', () => {
  beforeEach(() => vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('a successful sign-in finishes onboarding (the first one since the claim)', async () => {
    const { controller, finishIfClaimed } = make();
    const res = fakeRes();
    await controller.callback(req, res, 'code-1', 'state-1');
    expect(res.cookie).toHaveBeenCalledWith('mp_session', 'session-token', expect.anything());
    expect(finishIfClaimed).toHaveBeenCalledOnce();
    expect(res.redirect).toHaveBeenCalledWith(302, '/');
  });

  it('a failed finish write never fails the sign-in — status retries it', async () => {
    const { controller } = make(vi.fn(async () => { throw new Error('sealed'); }));
    const res = fakeRes();
    await controller.callback(req, res, 'code-1', 'state-1');
    expect(res.cookie).toHaveBeenCalledWith('mp_session', 'session-token', expect.anything());
    expect(res.redirect).toHaveBeenCalledWith(302, '/');
  });

  it('a bad state is refused before anything is finished', async () => {
    const { controller, finishIfClaimed } = make();
    await expect(controller.callback(req, fakeRes(), 'code-1', 'other-state')).rejects.toThrow(BadRequestException);
    expect(finishIfClaimed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/auth/auth.controller.spec.ts
```
Expected: FAIL, because `finishIfClaimed` is never called (the controller takes no store yet).

- [ ] **Step 9: Add the finish hook**

In `ui/packages/server/src/auth/auth.controller.ts`:

1. Change the first import line to

```ts
import { BadRequestException, Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
```

and add

```ts
import { OnboardingStore } from '../onboarding/onboarding-store';
```

2. Replace the class's constructor with

```ts
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly casdoor: CasdoorService,
    private readonly session: SessionService,
    private readonly onboarding: OnboardingStore,
  ) {}
```

3. In `callback`, directly after `res.cookie(this.session.cookieName, token, cookieOpts(this.session.ttlSeconds));`, insert

```ts
    // The first sign-in since the claim finishes onboarding (spec §8). It never
    // blocks the sign-in: a failed write is retried by the next authenticated
    // GET /api/bootstrap/status.
    await this.onboarding
      .finishIfClaimed()
      .catch((err: Error) => this.logger.warn(`finishing onboarding failed: ${err.message}`));
```

In `ui/packages/server/src/auth/auth.module.ts`, add `import { OnboardingStoreModule } from '../onboarding/onboarding-store.module';` and the module option

```ts
  // The SSO callback finishes first-run onboarding (OnboardingStore).
  imports: [OnboardingStoreModule],
```

- [ ] **Step 10: Run unit tests, e2e and the typecheck**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm test && npm run test:e2e
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
```
Expected:
- All unit tests pass.
- The e2e suites pass, including `Auth (e2e)`. Its callback happy path still mints a session: with `OPENBAO_ADDR` unset the finish hook fails and is logged, and the store's start-up logs one "not ready" warning and retries in the background.
- tsc exits 0.

- [ ] **Step 11: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/auth ui/packages/server/src/onboarding/onboarding.guard.ts ui/packages/server/src/onboarding/onboarding.guard.spec.ts
git commit -m "feat(ui): onboarding cookie bound to the record's generation; the first SSO sign-in finishes onboarding"
git log --oneline -1
```

---
### Task 9: WireGuard proxy (carried from #215) and the shared onboarding types

**Files:**
- Create (carry): `ui/packages/server/src/onboarding/wg-easy.service.ts`, `wg-easy.service.spec.ts`, `wireguard.controller.ts`, `wireguard.controller.spec.ts`
- Modify: `ui/packages/shared/src/types.ts` (append; written fresh, not #215's shape)

**Interfaces:**
- Consumes: `OnboardingGuard` (Task 8), `OpenBaoClient.readAppSettings` (unchanged).
- Produces:
  - `WgEasyService.listClients(): Promise<WgPeer[]>`, `createClient(name: string): Promise<{ clientId: string }>`, `clientConfiguration(id: string): Promise<string>` and `clientQrSvg(id: string): Promise<string>`. It uses Basic auth with OpenBao `apps/wg-easy` `INIT_PASSWORD`. A 401 becomes a 503 with "WireGuard rejected its admin password — …".
  - `WireguardController` at `bootstrap/wireguard`, guarded by `OnboardingGuard`: `GET /`, `POST /peer`, `GET /clients/:id/configuration` and `GET /clients/:id/qrcode.svg`.
  - Shared: `OnboardingState`, `ArrivalKind`, `OnboardingStatus`, `WgPeer`, `BootstrapInstallRequest` (exact shapes below).

- [ ] **Step 1: Add the shared types**

Append to `ui/packages/shared/src/types.ts`:

```ts
/** First-run onboarding (the onboarding record in OpenBao system/). `waiting` is
 * never stored: OpenBao is unreachable, or the record is open/claimed and Casdoor
 * is unreachable. */
export type OnboardingState = 'waiting' | 'open' | 'claimed' | 'finished';

/** How the browser reached the server: a raw IPv4/IPv6 literal vs a name. */
export type ArrivalKind = 'ip' | 'domain';

export interface OnboardingStatus {
  state: OnboardingState;
  arrival: ArrivalKind;
  baseDomain: string;
  /** This browser holds a valid onboarding cookie for the current generation. */
  session: boolean;
  // Everything below is null unless `session`.
  /** The personal account confirmed since the last claim ("sign in as …"). */
  account: string | null;
  /** An account kept from before a reset, not yet confirmed since the claim ("keep …"). */
  previousAccount: string | null;
  /** The VPN app's (wg-easy's) install status; null when the read failed. */
  vpnStatus: AppStatus | null;
  peerCount: number | null;
  /** ISO timestamp of the most recent WireGuard handshake, null if none. */
  lastHandshakeAt: string | null;
  /** Pre-fill for the WireGuard endpoint host: the IP the browser used, else DEVICE_IP. */
  endpointSuggestion: string | null;
}

export interface WgPeer {
  clientId: string;
  name: string;
  enabled: boolean;
  latestHandshakeAt: string | null;
}

/** Body of POST /api/bootstrap/install: a VPN app through the catalog's install path.
 * The server answers the app's admin-password question itself; no custom variables. */
export interface BootstrapInstallRequest {
  app: string;
  settings?: Record<string, string>;
}
```

- [ ] **Step 2: Carry the wg-easy proxy**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git diff db77265 b42337c -- \
  ui/packages/server/src/onboarding/wg-easy.service.ts \
  ui/packages/server/src/onboarding/wg-easy.service.spec.ts \
  ui/packages/server/src/onboarding/wireguard.controller.ts \
  ui/packages/server/src/onboarding/wireguard.controller.spec.ts \
  | git apply --3way
```

In `ui/packages/server/src/onboarding/wg-easy.service.ts`, replace the last sentence of the class doc comment

```ts
 * own UI, this copy goes stale and the wizard's peer calls fail; that only
 * matters during the tour (spec, "Known limits").
```

with

```ts
 * own UI, this copy goes stale and the wizard's peer calls fail with the 401
 * message below.
```

- [ ] **Step 3: Run the carried tests and the typecheck**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/wg-easy.service.spec.ts src/onboarding/wireguard.controller.spec.ts && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
```
Expected: PASS (8 `WgEasyService` and 6 `WireguardController` tests); tsc exits 0.

- [ ] **Step 4: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/shared/src/types.ts ui/packages/server/src/onboarding/wg-easy.service.ts ui/packages/server/src/onboarding/wg-easy.service.spec.ts ui/packages/server/src/onboarding/wireguard.controller.ts ui/packages/server/src/onboarding/wireguard.controller.spec.ts
git commit -m "feat(ui): wizard's WireGuard proxy (peers, QR, config) and the shared onboarding types"
git log --oneline -1
```

---
### Task 10: Onboarding service — claim, resume, account

**Files:**
- Create: `ui/packages/server/src/onboarding/onboarding.service.ts`
- Create: `ui/packages/server/test/fixtures/fake-casdoor.ts`
- Test: `ui/packages/server/src/onboarding/onboarding.service.spec.ts`

**Interfaces:**
- Consumes:
  - `OnboardingStore` (`record`, `save`, `adminPassword`, `saveAdminPassword`), `OnboardingRecord`, `STORE_UNAVAILABLE` (Task 5).
  - `CasdoorAdminService` (`factoryPassword`, `signIn`, `setAdminPassword`, `ensureOrganization`, `getUser`, `addUser`, `setUserPassword`) and `CasdoorSession` (Task 7).
  - `setupCodeMatches` (Task 4).
- Produces:
  - `MIN_PASSWORD_LENGTH = 12`.
  - `checkPassword(value: unknown): string`: 400 `Use at least 12 characters, without spaces`.
  - `class OnboardingService` with these methods:
    - `claim(input: { code: unknown; password: unknown }, source: string): Promise<OnboardingRecord>`: returns the claimed record.
    - `resume(code: unknown, source: string): Promise<OnboardingRecord>`
    - `account(input: { username: unknown; password?: unknown }): Promise<OnboardingRecord>`
    - `adminPassword(): Promise<string>`: 503 when missing or unreadable.
  - Errors:
    - OpenBao trouble becomes 503 `STORE_UNAVAILABLE`.
    - A wrong code is 403 `That setup code isn't right`, logged as `wrong setup code from <source>`.
    - Casdoor rejecting every admin password is 409 `Casdoor's admin password was changed outside LibrePod`.
  - `test/fixtures/fake-casdoor.ts` exports `fakeCasdoor(adminPassword = '123')`, which returns `{ casdoor, state: { adminPassword, users: Map<string, string> } }`. Task 11 reuses it.

- [ ] **Step 1: Create the Casdoor fixture**

Create `ui/packages/server/test/fixtures/fake-casdoor.ts`:

```ts
import { vi } from 'vitest';
import type { CasdoorSession } from '../../src/onboarding/casdoor-admin.service';

/** Casdoor's built-in admin and the platform org's users, in memory: the slice of
 * CasdoorAdminService onboarding uses. Starts at the factory password "123". */
export function fakeCasdoor(adminPassword = '123') {
  const state = { adminPassword, users: new Map<string, string>() };
  const casdoor = {
    factoryPassword: '123',
    reachable: vi.fn(async () => true),
    signIn: vi.fn(async (candidates: string[]): Promise<CasdoorSession | null> => {
      const password = candidates.find((p) => p !== '' && p === state.adminPassword);
      return password ? { cookie: 'casdoor_session_id=fake', password } : null;
    }),
    setAdminPassword: vi.fn(async (_session: CasdoorSession, password: string) => {
      state.adminPassword = password;
    }),
    ensureOrganization: vi.fn(async () => undefined),
    getUser: vi.fn(async (_session: CasdoorSession, name: string) => (state.users.has(name) ? { name } : null)),
    addUser: vi.fn(async (_session: CasdoorSession, name: string, password: string) => {
      state.users.set(name, password);
    }),
    setUserPassword: vi.fn(async (_session: CasdoorSession, name: string, password: string) => {
      state.users.set(name, password);
    }),
  };
  return { casdoor, state };
}
```

- [ ] **Step 2: Write the failing service tests**

Create `ui/packages/server/src/onboarding/onboarding.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingService } from './onboarding.service';
import { OnboardingStore } from './onboarding-store';
import { formatSetupCode } from './setup-code';
import type { CasdoorAdminService } from './casdoor-admin.service';
import { OpenBaoUnavailableError, type OpenBaoClient } from '../installed/openbao.client';
import { FakeKv } from '../../test/fixtures/fake-kv';
import { fakeCasdoor } from '../../test/fixtures/fake-casdoor';

const RECORD = 'marketplace-ui/onboarding';
const ADMIN = 'admin-password-12';

function make(casdoorPassword = '123') {
  const kv = new FakeKv();
  const store = new OnboardingStore(kv as unknown as OpenBaoClient, new ConfigService({}));
  const { casdoor, state } = fakeCasdoor(casdoorPassword);
  const service = new OnboardingService(store, casdoor as unknown as CasdoorAdminService);
  return { kv, store, casdoor, state, service };
}

/** A device claimed with ADMIN, as after a successful claim. */
async function claimed() {
  const t = make();
  await t.service.claim({ code: (await t.store.record()).code, password: ADMIN }, '10.0.0.9');
  return t;
}

describe('OnboardingService', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('claim', () => {
    it('with the factory password: sets the admin password, stores it, ensures the org, records claimed', async () => {
      const { service, store, kv, casdoor, state } = make();
      const { code } = await store.record();
      const record = await service.claim({ code, password: ADMIN }, '10.0.0.9');
      expect(record).toMatchObject({ state: 'claimed', claimedAt: expect.any(String) });
      expect(state.adminPassword).toBe(ADMIN);
      expect(kv.get('system', 'admin')).toEqual({ password: ADMIN });
      expect(casdoor.ensureOrganization).toHaveBeenCalledOnce();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'claimed' });
    });

    it('accepts the code typed in lowercase with dashes or spaces', async () => {
      const { service, store } = make();
      const { code } = await store.record();
      const typed = ` ${formatSetupCode(code).toLowerCase().replace('-', ' ')} `;
      await expect(service.claim({ code: typed, password: ADMIN }, '10.0.0.9')).resolves.toMatchObject({ state: 'claimed' });
    });

    it('a wrong code is a 403 that changes nothing and logs the source, never the attempt', async () => {
      const { service, kv, state } = make();
      await expect(service.claim({ code: 'AAAA-BBBB-CCCC', password: ADMIN }, '10.0.0.9')).rejects.toThrow(
        new ForbiddenException("That setup code isn't right"),
      );
      expect(state.adminPassword).toBe('123');
      expect(kv.get('system', 'admin')).toBeUndefined();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open' });
      expect(warn).toHaveBeenCalledWith('wrong setup code from 10.0.0.9');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('AAAA');
    });

    it('a weak or non-text password is a 400 after the code check, before Casdoor', async () => {
      const { service, store, casdoor } = make();
      const { code } = await store.record();
      for (const password of ['elevenchars', 'has space 12345', 123456789012, undefined]) {
        await expect(service.claim({ code, password }, '10.0.0.9')).rejects.toThrow(BadRequestException);
      }
      expect(casdoor.signIn).not.toHaveBeenCalled();
    });

    it('a retry after a crash between set-password and the OpenBao write signs in with the new password', async () => {
      const { service, store, kv, casdoor } = make(ADMIN); // Casdoor already has it; system/admin does not
      const { code } = await store.record();
      await service.claim({ code, password: ADMIN }, '10.0.0.9');
      expect(casdoor.setAdminPassword).not.toHaveBeenCalled();
      expect(kv.get('system', 'admin')).toEqual({ password: ADMIN });
    });

    it('after a reset: signs in with the stored admin password and replaces it', async () => {
      const t = await claimed();
      const code = await t.store.reset();
      await t.service.claim({ code, password: 'new-admin-pass-12' }, '10.0.0.9');
      expect(t.casdoor.signIn).toHaveBeenLastCalledWith([ADMIN, '123', 'new-admin-pass-12']);
      expect(t.state.adminPassword).toBe('new-admin-pass-12');
      expect(t.kv.get('system', 'admin')).toEqual({ password: 'new-admin-pass-12' });
    });

    it('Casdoor accepting none of the passwords is a 409 that writes nothing', async () => {
      const { service, store, kv } = make('changed-by-hand-1');
      const { code } = await store.record();
      await expect(service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(
        new ConflictException("Casdoor's admin password was changed outside LibrePod"),
      );
      expect(kv.get('system', 'admin')).toBeUndefined();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open' });
    });

    it('already claimed or finished is a 409', async () => {
      const t = await claimed();
      const { code } = await t.store.record();
      await expect(t.service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(ConflictException);
      await t.store.finishIfClaimed();
      await expect(t.service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(ConflictException);
    });

    it('OpenBao down is a 503; Casdoor down is a 503 that leaves the record open', async () => {
      const down = make();
      down.kv.failWith = new OpenBaoUnavailableError('sealed');
      await expect(down.service.claim({ code: 'X', password: ADMIN }, '10.0.0.9')).rejects.toThrow(
        ServiceUnavailableException,
      );

      const t = make();
      const { code } = await t.store.record();
      t.casdoor.signIn.mockRejectedValueOnce(new ServiceUnavailableException('casdoor down'));
      await expect(t.service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(ServiceUnavailableException);
      expect(t.kv.get('system', RECORD)).toMatchObject({ state: 'open' });
    });
  });

  describe('resume', () => {
    it('the right code returns the claimed record; a wrong one is a 403', async () => {
      const t = await claimed();
      const { code } = await t.store.record();
      await expect(t.service.resume(code, '10.0.0.9')).resolves.toMatchObject({ state: 'claimed' });
      await expect(t.service.resume('AAAA-BBBB-CCCC', '10.0.0.9')).rejects.toThrow(ForbiddenException);
    });

    it('open or finished is a 409', async () => {
      const t = make();
      const { code } = await t.store.record();
      await expect(t.service.resume(code, '10.0.0.9')).rejects.toThrow(ConflictException);
      const c = await claimed();
      await c.store.finishIfClaimed();
      await expect(c.service.resume((await c.store.record()).code, '10.0.0.9')).rejects.toThrow(ConflictException);
    });
  });

  describe('account', () => {
    it('creates the personal user and records it for this generation', async () => {
      const t = await claimed();
      const record = await t.service.account({ username: 'alex', password: 'personal-pass-12' });
      expect(t.state.users.get('alex')).toBe('personal-pass-12');
      expect(record).toMatchObject({ account: 'alex', accountGeneration: record.generation });
      expect(t.kv.get('system', RECORD)).toMatchObject({ account: 'alex', accountGeneration: 1 });
    });

    it('an existing user is kept as is without a password, or re-passworded with one', async () => {
      const t = await claimed();
      t.state.users.set('alex', 'forgotten-pass-12');
      await t.service.account({ username: 'alex' });
      expect(t.casdoor.addUser).not.toHaveBeenCalled();
      expect(t.casdoor.setUserPassword).not.toHaveBeenCalled();
      await t.service.account({ username: 'alex', password: 'brand-new-pass-12' });
      expect(t.state.users.get('alex')).toBe('brand-new-pass-12');
    });

    it('a new user needs a password', async () => {
      const t = await claimed();
      await expect(t.service.account({ username: 'alex' })).rejects.toThrow(
        new BadRequestException('Choose a password for the new account'),
      );
    });

    it('usernames: lowercase letters, digits, dots and dashes, 1–39 characters, never admin', async () => {
      const t = await claimed();
      for (const username of ['Alex', 'admin', '', 'a'.repeat(40), 'al ex', 'al_ex', 'al@ex', 42, undefined]) {
        await expect(t.service.account({ username, password: 'personal-pass-12' })).rejects.toThrow(BadRequestException);
      }
      expect(t.casdoor.addUser).not.toHaveBeenCalled();
      await expect(t.service.account({ username: 'a.l-ex9', password: 'personal-pass-12' })).resolves.toBeDefined();
    });

    it('a weak personal password is a 400', async () => {
      const t = await claimed();
      await expect(t.service.account({ username: 'alex', password: 'short' })).rejects.toThrow(BadRequestException);
    });

    it('no stored admin password is a 503', async () => {
      const t = await claimed();
      await t.kv.writeEntry('system', 'admin', {});
      await expect(t.service.account({ username: 'alex', password: 'personal-pass-12' })).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/onboarding.service.spec.ts
```
Expected: FAIL, because `./onboarding.service` does not exist.

- [ ] **Step 4: Implement**

Create `ui/packages/server/src/onboarding/onboarding.service.ts`:

```ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CasdoorAdminService } from './casdoor-admin.service';
import { OnboardingStore, STORE_UNAVAILABLE, type OnboardingRecord } from './onboarding-store';
import { setupCodeMatches } from './setup-code';

/** wg-easy rejects shorter admin passwords at login; Casdoor's set-password rejects whitespace. */
export const MIN_PASSWORD_LENGTH = 12;
const USERNAME = /^[a-z0-9.-]{1,39}$/;
const CHANGED_OUTSIDE = "Casdoor's admin password was changed outside LibrePod";

export function checkPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || /\s/.test(value)) {
    throw new BadRequestException(`Use at least ${MIN_PASSWORD_LENGTH} characters, without spaces`);
  }
  return value;
}

/** Claim, resume and account (spec §8). HTTP lives in BootstrapController. */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly store: OnboardingStore,
    private readonly casdoor: CasdoorAdminService,
  ) {}

  /** Every step is idempotent, so a failed claim is simply retried. */
  async claim(input: { code: unknown; password: unknown }, source: string): Promise<OnboardingRecord> {
    const record = await this.stored(this.store.record());
    if (record.state === 'claimed') {
      throw new ConflictException('This device is already claimed — enter the setup code to continue');
    }
    if (record.state === 'finished') throw new ConflictException('This device is already set up');
    this.checkCode(input.code, record, source);
    const password = checkPassword(input.password);

    // The stored admin password (present after a reset), the factory one, or the new
    // one itself — the last makes a retry after a crash between set-password and the
    // OpenBao write below succeed.
    const stored = await this.stored(this.store.adminPassword());
    const session = await this.casdoor.signIn([stored ?? '', this.casdoor.factoryPassword, password]);
    if (!session) throw new ConflictException(CHANGED_OUTSIDE);
    if (session.password !== password) await this.casdoor.setAdminPassword(session, password);
    await this.stored(this.store.saveAdminPassword(password));
    await this.casdoor.ensureOrganization(session);

    const claimed: OnboardingRecord = { ...record, state: 'claimed', claimedAt: new Date().toISOString() };
    await this.stored(this.store.save(claimed));
    this.logger.log(`device claimed from ${source}`);
    return claimed;
  }

  async resume(code: unknown, source: string): Promise<OnboardingRecord> {
    const record = await this.stored(this.store.record());
    if (record.state === 'open') throw new ConflictException('This device is not claimed yet — claim it with the setup code');
    if (record.state === 'finished') throw new ConflictException('This device is already set up');
    this.checkCode(code, record, source);
    return record;
  }

  /** Creates the personal user, or keeps an existing one (after a reset), setting a
   * new password when one is given — the recovery for a forgotten personal password. */
  async account(input: { username: unknown; password?: unknown }): Promise<OnboardingRecord> {
    const username = typeof input.username === 'string' ? input.username : '';
    if (!USERNAME.test(username) || username === 'admin') {
      throw new BadRequestException('Use 1–39 lowercase letters, digits, dots or dashes — "admin" is taken');
    }
    const given = input.password;
    const password = given === undefined || given === null || given === '' ? null : checkPassword(given);
    const record = await this.stored(this.store.record());
    if (record.state !== 'claimed') throw new ConflictException('Claim this device first');

    const session = await this.casdoor.signIn([await this.adminPassword()]);
    if (!session) throw new ConflictException(CHANGED_OUTSIDE);
    if (!(await this.casdoor.getUser(session, username))) {
      if (!password) throw new BadRequestException('Choose a password for the new account');
      await this.casdoor.addUser(session, username, password);
    } else if (password) {
      await this.casdoor.setUserPassword(session, username, password);
    }

    const next: OnboardingRecord = { ...record, account: username, accountGeneration: record.generation };
    await this.stored(this.store.save(next));
    return next;
  }

  /** The admin password from system/admin. */
  async adminPassword(): Promise<string> {
    const password = await this.stored(this.store.adminPassword());
    if (!password) throw new ServiceUnavailableException("The admin password isn't available — try again in a minute.");
    return password;
  }

  private checkCode(code: unknown, record: OnboardingRecord, source: string): void {
    if (setupCodeMatches(code, record.code)) return;
    // The source address, never the attempted value.
    this.logger.warn(`wrong setup code from ${source}`);
    throw new ForbiddenException("That setup code isn't right");
  }

  /** OpenBao trouble is a retryable 503 for the wizard; HTTP errors pass through. */
  private async stored<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`onboarding store: ${(err as Error).message}`);
      throw new ServiceUnavailableException(STORE_UNAVAILABLE);
    }
  }
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/onboarding.service.spec.ts && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
```
Expected: PASS (17 tests); tsc exits 0.

- [ ] **Step 6: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/onboarding/onboarding.service.ts ui/packages/server/src/onboarding/onboarding.service.spec.ts ui/packages/server/test/fixtures/fake-casdoor.ts
git commit -m "feat(ui): claim with the setup code, resume, and the personal account — idempotent, fail closed"
git log --oneline -1
```

---
### Task 11: Bootstrap API — status, claim, resume, account, install, CA; module wiring; API e2e

**Files:**
- Create: `ui/packages/server/src/onboarding/bootstrap.controller.ts` (written fresh; #215's CA handler and host parsing reused)
- Create: `ui/packages/server/src/onboarding/onboarding.module.ts`
- Modify: `ui/packages/server/src/app.module.ts`
- Test: `ui/packages/server/src/onboarding/bootstrap.controller.spec.ts`, `ui/packages/server/test/onboarding.e2e-spec.ts`

**Interfaces:**
- Consumes:
  - `OnboardingService` (Task 10).
  - `OnboardingStore` (`record`, `finishIfClaimed`) and `OnboardingRecord` (Task 5).
  - `CasdoorAdminService.reachable` (Task 7).
  - `WgEasyService.listClients` (Task 9).
  - `SessionService` and `SESSION_COOKIE`.
  - `ONBOARDING_COOKIE`, `OnboardingGuard`, `isOnboardingSession` (Task 8).
  - `InstalledService.appStatus` and `install`, `NodeAddressService.internalIp` (Task 1).
  - Shared `OnboardingStatus`, `OnboardingState`, `BootstrapInstallRequest`, `InstallResult` (Task 9).
- Produces, all under `/api/bootstrap`:
  - `GET status`: public, never sets a cookie.
  - `POST claim`, `POST resume`: 200, set `mp_onboarding`.
  - `POST account`, `POST install`: 200, `OnboardingGuard`.
  - `GET ca`.
  - `OnboardingModule` is registered in `AppModule`.
  - Constructor order: `BootstrapController(onboarding, store, casdoor, wgEasy, session, config, installed, nodeAddress)`.

- [ ] **Step 1: Write the failing controller tests**

Create `ui/packages/server/src/onboarding/bootstrap.controller.spec.ts`:

```ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WgPeer } from '@librepod/shared';
import { BootstrapController } from './bootstrap.controller';
import { SessionService } from '../auth/session.service';
import type { OnboardingRecord, OnboardingStore } from './onboarding-store';
import type { OnboardingService } from './onboarding.service';
import type { CasdoorAdminService } from './casdoor-admin.service';
import type { WgEasyService } from './wg-easy.service';
import type { InstalledService } from '../installed/installed.service';
import type { NodeAddressService } from '../installed/node-address.service';

const claimed: OnboardingRecord = {
  state: 'claimed', code: '7KQMX3RT9VHC', generation: 3, account: null, accountGeneration: null,
  createdAt: '2026-10-14T09:00:00.000Z', claimedAt: '2026-10-14T10:00:00.000Z', finishedAt: null,
};

let session: SessionService;
beforeAll(() => {
  process.env.SESSION_SECRET = 'bootstrap-controller-spec';
  session = new SessionService();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BOOTSTRAP_MODE_OVERRIDE;
  delete process.env.ROOT_CA_PATH;
});

function make(o: {
  record?: OnboardingRecord | Error;
  reachable?: boolean;
  vpn?: string | Error;
  peers?: WgPeer[] | Error;
  deviceIp?: string | Error;
  adminPassword?: string | Error;
} = {}) {
  const value = <T>(v: T | Error): T => {
    if (v instanceof Error) throw v;
    return v;
  };
  const store = {
    record: vi.fn(async () => value(o.record ?? claimed)),
    finishIfClaimed: vi.fn(async () => false),
  };
  const onboarding = {
    claim: vi.fn(async () => claimed),
    resume: vi.fn(async () => claimed),
    account: vi.fn(async () => claimed),
    adminPassword: vi.fn(async () => value(o.adminPassword ?? 'admin-password-12')),
  };
  const casdoor = { reachable: vi.fn(async () => o.reachable ?? true) };
  const wgEasy = { listClients: vi.fn(async () => value(o.peers ?? [])) };
  const installed = {
    appStatus: vi.fn(async () => value(o.vpn ?? 'not_installed')),
    install: vi.fn(async () => ({ success: true, message: 'WG Easy is being deployed' })),
  };
  const nodeAddress = { internalIp: vi.fn(async () => value(o.deviceIp ?? '192.168.1.50')) };
  const controller = new BootstrapController(
    onboarding as unknown as OnboardingService,
    store as unknown as OnboardingStore,
    casdoor as unknown as CasdoorAdminService,
    wgEasy as unknown as WgEasyService,
    session,
    new ConfigService({ BASE_DOMAIN: 'libre.pod' }),
    installed as unknown as InstalledService,
    nodeAddress as unknown as NodeAddressService,
  );
  return { controller, store, onboarding, casdoor, wgEasy, installed, nodeAddress };
}

function req(host: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return { headers: { 'x-forwarded-host': host, ...headers }, cookies, ip: '10.0.0.9' } as unknown as Request;
}
const withCookie = (generation = 3) => ({
  mp_onboarding: session.sign({ sub: 'onboarding', name: 'onboarding', email: '', generation }),
});
function fakeRes() {
  return { cookie: vi.fn(), setHeader: vi.fn(), send: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

describe('BootstrapController.status', () => {
  it('BOOTSTRAP_MODE_OVERRIDE forces the state without reading anything (Tier 1)', async () => {
    process.env.BOOTSTRAP_MODE_OVERRIDE = 'finished';
    const { controller, store, casdoor } = make();
    expect((await controller.status(req('localhost'))).state).toBe('finished');
    expect(store.record).not.toHaveBeenCalled();
    expect(casdoor.reachable).not.toHaveBeenCalled();
  });

  it('a signed-in user gets the app — finished — even with OpenBao down; the finish write is retried', async () => {
    const { controller, store } = make({ record: new Error('sealed') });
    const sso = { mp_session: session.sign({ sub: 'alex', name: 'alex', email: 'alex@libre.pod' }) };
    expect(await controller.status(req('libre.pod', sso))).toMatchObject({ state: 'finished', arrival: 'domain' });
    expect(store.finishIfClaimed).toHaveBeenCalledWith(expect.any(Number));
  });

  it('the onboarding token in the session cookie is not a signed-in user', async () => {
    const { controller, store } = make({ record: { ...claimed, state: 'open' } });
    const status = await controller.status(req('libre.pod', { mp_session: withCookie().mp_onboarding }));
    expect(status.state).toBe('open');
    expect(store.finishIfClaimed).not.toHaveBeenCalled();
  });

  it('waiting while OpenBao cannot answer', async () => {
    expect((await make({ record: new Error('sealed') }).controller.status(req('192.168.1.50'))).state).toBe('waiting');
  });

  it('waiting while Casdoor is down before onboarding finishes; finished needs no Casdoor', async () => {
    const open = make({ record: { ...claimed, state: 'open' }, reachable: false });
    expect((await open.controller.status(req('192.168.1.50'))).state).toBe('waiting');
    const finished = make({ record: { ...claimed, state: 'finished' }, reachable: false });
    expect((await finished.controller.status(req('192.168.1.50'))).state).toBe('finished');
    expect(finished.casdoor.reachable).not.toHaveBeenCalled();
  });

  it('IPv4 and IPv6 literals are ip arrivals; names are domain arrivals', async () => {
    const { controller } = make({ record: { ...claimed, state: 'open' } });
    for (const host of ['192.168.1.50', '192.168.1.50:8080', '[2001:db8::1]', '[2001:db8::1]:8080']) {
      expect((await controller.status(req(host))).arrival).toBe('ip');
    }
    for (const host of ['libre.pod', 'marketplace.libre.pod', 'localhost']) {
      expect((await controller.status(req(host))).arrival).toBe('domain');
    }
  });

  it('without the onboarding cookie: the state only — nothing read from the VPN', async () => {
    const { controller, installed, wgEasy } = make();
    expect(await controller.status(req('192.168.1.50'))).toEqual({
      state: 'claimed', arrival: 'ip', baseDomain: 'libre.pod', session: false, account: null,
      previousAccount: null, vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
    });
    expect(installed.appStatus).not.toHaveBeenCalled();
    expect(wgEasy.listClients).not.toHaveBeenCalled();
  });

  it('a cookie from another generation (a reset since) is no session', async () => {
    expect((await make().controller.status(req('192.168.1.50', withCookie(2)))).session).toBe(false);
  });

  it('with the cookie: VPN telemetry with the latest handshake, and the arrival IP as endpoint', async () => {
    const peers: WgPeer[] = [
      { clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: '2026-10-14T10:00:00Z' },
      { clientId: 'b', name: 'laptop', enabled: true, latestHandshakeAt: '2026-10-14T09:00:00Z' },
    ];
    const { controller } = make({ vpn: 'running', peers });
    expect(await controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      session: true, vpnStatus: 'running', peerCount: 2, lastHandshakeAt: '2026-10-14T10:00:00Z',
      endpointSuggestion: '192.168.1.50',
    });
  });

  it('not installed: no wg-easy call; rolling out and not answering: still answers; status read failing: null', async () => {
    const notInstalled = make({ vpn: 'not_installed' });
    expect((await notInstalled.controller.status(req('192.168.1.50', withCookie()))).peerCount).toBeNull();
    expect(notInstalled.wgEasy.listClients).not.toHaveBeenCalled();

    const rolling = make({ vpn: 'installing', peers: new Error('503') });
    expect(await rolling.controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      vpnStatus: 'installing', peerCount: null,
    });

    const unknown = make({ vpn: new Error('git unreachable') });
    expect((await unknown.controller.status(req('192.168.1.50', withCookie()))).vpnStatus).toBeNull();
  });

  it('an account confirmed since the claim is `account`; one kept from before a reset is `previousAccount`', async () => {
    const confirmed = make({ record: { ...claimed, account: 'alex', accountGeneration: 3 } });
    expect(await confirmed.controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      account: 'alex', previousAccount: null,
    });
    const kept = make({ record: { ...claimed, account: 'alex', accountGeneration: 1 } });
    expect(await kept.controller.status(req('192.168.1.50', withCookie()))).toMatchObject({
      account: null, previousAccount: 'alex',
    });
  });

  it('endpoint: loopback, link-local and name arrivals fall back to DEVICE_IP; a failed lookup is null', async () => {
    for (const host of ['127.0.0.1', '169.254.10.1', '[::1]', '[fe80::1]', 'libre.pod']) {
      expect((await make().controller.status(req(host, withCookie()))).endpointSuggestion).toBe('192.168.1.50');
    }
    const lost = make({ deviceIp: new ServiceUnavailableException('no node') });
    expect((await lost.controller.status(req('127.0.0.1', withCookie()))).endpointSuggestion).toBeNull();
  });
});

describe('BootstrapController.claim / resume', () => {
  it('claim sets the onboarding cookie for the record\'s generation — httpOnly, lax, not Secure', async () => {
    const { controller, onboarding } = make();
    const res = fakeRes();
    await expect(controller.claim({ code: 'c', password: 'p' }, req('192.168.1.50'), res)).resolves.toEqual({ ok: true });
    expect(onboarding.claim).toHaveBeenCalledWith({ code: 'c', password: 'p' }, '10.0.0.9');
    const [name, token, opts] = res.cookie.mock.calls[0];
    expect(name).toBe('mp_onboarding');
    expect(session.verify(token)).toMatchObject({ sub: 'onboarding', generation: 3 });
    expect(opts).toEqual({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: session.ttlSeconds * 1000 });
  });

  it('logs the first X-Forwarded-For address as the source', async () => {
    const { controller, onboarding } = make();
    await controller.claim({}, req('192.168.1.50', {}, { 'x-forwarded-for': '192.168.1.20, 10.42.0.1' }), fakeRes());
    expect(onboarding.claim).toHaveBeenCalledWith({ code: undefined, password: undefined }, '192.168.1.20');
  });

  it('a refused claim sets no cookie', async () => {
    const { controller, onboarding } = make();
    onboarding.claim.mockRejectedValueOnce(new ConflictException('already claimed'));
    const res = fakeRes();
    await expect(controller.claim({ code: 'c', password: 'p' }, req('192.168.1.50'), res)).rejects.toThrow(
      ConflictException,
    );
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('resume sets the cookie when the code is right', async () => {
    const { controller, onboarding } = make();
    const res = fakeRes();
    await controller.resume({ code: 'c' }, req('192.168.1.50'), res);
    expect(onboarding.resume).toHaveBeenCalledWith('c', '10.0.0.9');
    expect(res.cookie).toHaveBeenCalledWith('mp_onboarding', expect.any(String), expect.anything());
  });
});

describe('BootstrapController.account', () => {
  it('delegates username and password', async () => {
    const { controller, onboarding } = make();
    await expect(controller.account({ username: 'alex', password: 'personal-pass-12' })).resolves.toEqual({ ok: true });
    expect(onboarding.account).toHaveBeenCalledWith({ username: 'alex', password: 'personal-pass-12' });
  });
});

describe('BootstrapController.install', () => {
  it("fills the admin password from system/admin — the browser's value never reaches the installer", async () => {
    const { controller, installed } = make();
    await controller.install({ app: 'wg-easy', settings: { INIT_HOST: '203.0.113.7', INIT_PASSWORD: 'from-the-browser' } });
    expect(installed.install).toHaveBeenCalledWith('wg-easy', {
      settings: { INIT_HOST: '203.0.113.7', INIT_PASSWORD: 'admin-password-12' },
    });
  });

  it('only VPN apps, checked before the admin password is read', async () => {
    const { controller, installed, onboarding } = make();
    for (const body of [{ app: 'vaultwarden' }, { app: '__proto__' }, { app: 'constructor' }, { app: 42 }, {}, undefined]) {
      await expect(controller.install(body as never)).rejects.toThrow(BadRequestException);
    }
    expect(onboarding.adminPassword).not.toHaveBeenCalled();
    expect(installed.install).not.toHaveBeenCalled();
  });

  it('settings that are not an object are dropped, never spread', async () => {
    const { controller, installed } = make();
    await controller.install({ app: 'wg-easy', settings: ['x'] as never });
    expect(installed.install).toHaveBeenCalledWith('wg-easy', { settings: { INIT_PASSWORD: 'admin-password-12' } });
  });

  it('no readable admin password is a 503 and nothing is installed', async () => {
    const { controller, installed } = make({ adminPassword: new ServiceUnavailableException('no admin password') });
    await expect(controller.install({ app: 'wg-easy' })).rejects.toThrow(ServiceUnavailableException);
    expect(installed.install).not.toHaveBeenCalled();
  });

  it('install errors pass through unchanged (the wizard counts 409 as success)', async () => {
    const { controller, installed } = make();
    installed.install.mockRejectedValueOnce(new ConflictException('WG Easy is already installed'));
    await expect(controller.install({ app: 'wg-easy' })).rejects.toThrow(ConflictException);
  });
});

describe('BootstrapController.ca', () => {
  it('streams the mounted root CA with download headers', () => {
    // a real temp file — the node:fs namespace is frozen and cannot be spied
    const dir = mkdtempSync(join(tmpdir(), 'root-ca-'));
    const file = join(dir, 'root_ca.crt');
    writeFileSync(file, '-----BEGIN CERTIFICATE-----\n…');
    process.env.ROOT_CA_PATH = file;
    try {
      const res = fakeRes();
      make().controller.ca(res);
      expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/x-x509-ca-cert');
      expect(res.send).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('404s when the CA is not mounted', () => {
    process.env.ROOT_CA_PATH = '/nonexistent/root_ca.crt';
    expect(() => make().controller.ca(fakeRes())).toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/bootstrap.controller.spec.ts
```
Expected: FAIL, because `./bootstrap.controller` does not exist.

- [ ] **Step 3: Implement the controller**

Create `ui/packages/server/src/onboarding/bootstrap.controller.ts`:

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import type { Request, Response } from 'express';
import type { BootstrapInstallRequest, InstallResult, OnboardingState, OnboardingStatus } from '@librepod/shared';
import { SessionService, SESSION_COOKIE } from '../auth/session.service';
import { InstalledService } from '../installed/installed.service';
import { NodeAddressService } from '../installed/node-address.service';
import { CasdoorAdminService } from './casdoor-admin.service';
import { OnboardingStore, type OnboardingRecord } from './onboarding-store';
import { ONBOARDING_COOKIE, OnboardingGuard, isOnboardingSession } from './onboarding.guard';
import { OnboardingService } from './onboarding.service';
import { WgEasyService } from './wg-easy.service';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

/** The VPN app whose state the wizard follows. */
const VPN_APP = 'wg-easy';
/** Apps the wizard may install, each with the install question the server answers
 * with the admin password (system/admin): the browser never sends it. */
const VPN_APPS: Readonly<Record<string, { adminPasswordSetting: string }>> = {
  'wg-easy': { adminPasswordSetting: 'INIT_PASSWORD' },
};

/** The bare host the browser used (no port, no IPv6 brackets). */
function hostOf(req: Request): string {
  const xfh = req.headers['x-forwarded-host'];
  const raw = (Array.isArray(xfh) ? xfh[0] : xfh) ?? req.headers.host ?? '';
  // "[2001:db8::1]:8080" → "2001:db8::1"; "192.168.1.1:80" → "192.168.1.1"
  return raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
}

const isIpv6 = (host: string) => host.includes(':') && IPV6.test(host);

/** An IP literal another device could dial: not loopback, link-local or unspecified. */
function dialable(host: string): boolean {
  if (IPV4.test(host)) return !/^(127\.|169\.254\.|0\.)/.test(host);
  if (isIpv6(host)) return !/^(::1?$|fe[89ab])/i.test(host);
  return false;
}

/** Who sent the request, for logs only. */
function sourceOf(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** First-run onboarding over HTTP (spec §10). Exempt from AuthGuard; the
 * cookie-gated endpoints carry OnboardingGuard. */
@Controller('bootstrap')
export class BootstrapController {
  private readonly logger = new Logger(BootstrapController.name);

  constructor(
    private readonly onboarding: OnboardingService,
    private readonly store: OnboardingStore,
    private readonly casdoor: CasdoorAdminService,
    private readonly wgEasy: WgEasyService,
    private readonly session: SessionService,
    private readonly config: ConfigService,
    private readonly installed: InstalledService,
    private readonly nodeAddress: NodeAddressService,
  ) {}

  /** Public and read-only; never sets a cookie. Telemetry only with a valid onboarding cookie. */
  @Get('status')
  async status(@Req() req: Request): Promise<OnboardingStatus> {
    const host = hostOf(req);
    const status: OnboardingStatus = {
      state: 'waiting',
      arrival: IPV4.test(host) || isIpv6(host) ? 'ip' : 'domain',
      baseDomain: this.config.get<string>('BASE_DOMAIN', 'libre.pod'),
      session: false,
      account: null,
      previousAccount: null,
      vpnStatus: null,
      peerCount: null,
      lastHandshakeAt: null,
      endpointSuggestion: null,
    };
    const override = process.env.BOOTSTRAP_MODE_OVERRIDE as OnboardingState | undefined;
    if (override) return { ...status, state: override };

    const cookies = req.cookies as Record<string, string> | undefined;
    // A signed-in user always gets the app: an OpenBao or Casdoor blip must never
    // tell them their device is "waking up". Raw-IP browsers never carry this
    // cookie (Secure, bound to the domain).
    const sso = this.session.verify(cookies?.[SESSION_COOKIE]);
    if (sso && sso.sub !== 'onboarding') {
      // Retries the SSO callback's finish write if it failed — the only write in a GET.
      void this.store
        .finishIfClaimed(sso.iat * 1000)
        .catch((err: Error) => this.logger.warn(`finishing onboarding failed: ${err.message}`));
      return { ...status, state: 'finished' };
    }

    let record: OnboardingRecord;
    try {
      record = await this.store.record();
    } catch {
      return status; // waiting: OpenBao can't answer
    }
    if (record.state !== 'finished' && !(await this.casdoor.reachable())) return status;
    status.state = record.state;
    status.session = isOnboardingSession(this.session, cookies?.[ONBOARDING_COOKIE], record);
    if (!status.session) return status;

    const confirmed = record.account !== null && record.accountGeneration === record.generation;
    status.account = confirmed ? record.account : null;
    status.previousAccount = confirmed ? null : record.account;
    status.vpnStatus = await this.installed.appStatus(VPN_APP).catch(() => null);
    // Not installed means no peers to count: skip the wg-easy call.
    if (status.vpnStatus !== 'not_installed') {
      try {
        const peers = await this.wgEasy.listClients();
        status.peerCount = peers.length;
        status.lastHandshakeAt =
          peers
            .map((p) => p.latestHandshakeAt)
            .filter((t): t is string => Boolean(t))
            .sort()
            .at(-1) ?? null;
      } catch {
        // still rolling out, or not answering yet — the next poll asks again
      }
    }
    status.endpointSuggestion = dialable(host) ? host : await this.nodeAddress.internalIp().catch(() => null);
    return status;
  }

  @Post('claim')
  @HttpCode(200)
  async claim(
    @Body() body: { code?: unknown; password?: unknown } | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const record = await this.onboarding.claim({ code: body?.code, password: body?.password }, sourceOf(req));
    this.setOnboardingCookie(res, record.generation);
    return { ok: true };
  }

  @Post('resume')
  @HttpCode(200)
  async resume(
    @Body() body: { code?: unknown } | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const record = await this.onboarding.resume(body?.code, sourceOf(req));
    this.setOnboardingCookie(res, record.generation);
    return { ok: true };
  }

  @Post('account')
  @HttpCode(200)
  @UseGuards(OnboardingGuard)
  async account(@Body() body: { username?: unknown; password?: unknown } | undefined): Promise<{ ok: true }> {
    await this.onboarding.account({ username: body?.username, password: body?.password });
    return { ok: true };
  }

  /** The wizard's VPN install through the catalog's own install path (same validation,
   * OpenBao write and Gogs commit). Errors pass through: 400 field errors, 409 already
   * installed (the wizard counts it as success), 503 retryable. */
  @Post('install')
  @HttpCode(200)
  @UseGuards(OnboardingGuard)
  async install(@Body() body: Partial<BootstrapInstallRequest> | undefined): Promise<InstallResult> {
    const app = body?.app;
    if (typeof app !== 'string' || !Object.hasOwn(VPN_APPS, app)) {
      throw new BadRequestException('Only a VPN app can be installed from setup');
    }
    const adminPassword = await this.onboarding.adminPassword();
    const settings = body?.settings;
    const answers = isPlainObject(settings) ? (settings as Record<string, string>) : {};
    return this.installed.install(app, {
      settings: { ...answers, [VPN_APPS[app].adminPasswordSetting]: adminPassword },
    });
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

  /** httpOnly, NOT Secure: the wizard IS the http://<ip> experience, and a Secure
   * cookie would be silently dropped there. Bound to the record's generation. */
  private setOnboardingCookie(res: Response, generation: number): void {
    const token = this.session.sign({ sub: 'onboarding', name: 'onboarding', email: '', generation });
    res.cookie(ONBOARDING_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: this.session.ttlSeconds * 1000,
    });
  }
}
```

- [ ] **Step 4: Run the controller tests**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/bootstrap.controller.spec.ts
```
Expected: PASS (24 tests).

- [ ] **Step 5: Wire the module**

Create `ui/packages/server/src/onboarding/onboarding.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstalledModule } from '../installed/installed.module';
import { OnboardingStoreModule } from './onboarding-store.module';
import { CasdoorAdminService } from './casdoor-admin.service';
import { WgEasyService } from './wg-easy.service';
import { OnboardingService } from './onboarding.service';
import { OnboardingGuard } from './onboarding.guard';
import { BootstrapController } from './bootstrap.controller';
import { WireguardController } from './wireguard.controller';

@Module({
  // AuthModule: SessionService (the onboarding cookie's HMAC). InstalledModule:
  // InstalledService (the VPN install), OpenBaoClient (wg-easy's install answer) and
  // NodeAddressService (the endpoint suggestion). OnboardingStoreModule: the record.
  imports: [AuthModule, InstalledModule, OnboardingStoreModule],
  controllers: [BootstrapController, WireguardController],
  providers: [CasdoorAdminService, WgEasyService, OnboardingService, OnboardingGuard],
})
export class OnboardingModule {}
```

In `ui/packages/server/src/app.module.ts`, add `import { OnboardingModule } from './onboarding/onboarding.module';` after the `AuthModule` import, and `OnboardingModule,` after `AuthModule,` in `imports`.

- [ ] **Step 6: Write the API e2e test**

Create `ui/packages/server/test/onboarding.e2e-spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { BootstrapController } from '../src/onboarding/bootstrap.controller';
import { WireguardController } from '../src/onboarding/wireguard.controller';
import { OnboardingGuard } from '../src/onboarding/onboarding.guard';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { OnboardingStore } from '../src/onboarding/onboarding-store';
import { CasdoorAdminService } from '../src/onboarding/casdoor-admin.service';
import { WgEasyService } from '../src/onboarding/wg-easy.service';
import { formatSetupCode } from '../src/onboarding/setup-code';
import { SessionService } from '../src/auth/session.service';
import { InstalledService } from '../src/installed/installed.service';
import { NodeAddressService } from '../src/installed/node-address.service';
import { OpenBaoUnavailableError, type OpenBaoClient } from '../src/installed/openbao.client';
import { FakeKv } from './fixtures/fake-kv';
import { fakeCasdoor } from './fixtures/fake-casdoor';

// HTTP-level on purpose: decorators (@Body, @UseGuards, @HttpCode) are invisible
// to unit tests that call controller methods directly. Real store, service, guard
// and SessionService; OpenBao, Casdoor, the installer and wg-easy are faked.
process.env.SESSION_SECRET = 'onboarding-e2e-secret';

const ADMIN = 'admin-password-12';

async function boot() {
  const kv = new FakeKv();
  const { casdoor, state } = fakeCasdoor();
  const installed = {
    install: vi.fn(async () => ({ success: true, message: 'WG Easy is being deployed' })),
    appStatus: vi.fn(async () => 'not_installed'),
  };
  const wgEasy = { listClients: vi.fn(async () => []), createClient: vi.fn(async () => ({ clientId: 'c1' })) };
  const moduleRef = await Test.createTestingModule({
    controllers: [BootstrapController, WireguardController],
    providers: [
      OnboardingService,
      OnboardingGuard,
      SessionService,
      {
        provide: OnboardingStore,
        useFactory: () => new OnboardingStore(kv as unknown as OpenBaoClient, new ConfigService({})),
      },
      { provide: CasdoorAdminService, useValue: casdoor },
      { provide: InstalledService, useValue: installed },
      { provide: WgEasyService, useValue: wgEasy },
      { provide: NodeAddressService, useValue: { internalIp: vi.fn(async () => '192.168.1.50') } },
      { provide: ConfigService, useValue: new ConfigService({ BASE_DOMAIN: 'libre.pod' }) },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();
  const store = app.get(OnboardingStore);
  return { app, server: app.getHttpServer(), kv, casdoor, state, installed, store };
}

function onboardingCookie(res: request.Response): string {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = raw.find((c) => c.startsWith('mp_onboarding='));
  if (!cookie) throw new Error('no onboarding cookie in the response');
  return cookie.split(';')[0];
}

describe('Onboarding API (e2e)', () => {
  let t: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    t = await boot();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.app.close();
    vi.restoreAllMocks();
  });

  it('open → claim → account → install → first sign-in → closed for good', async () => {
    const fresh = await request(t.server).get('/bootstrap/status').expect(200);
    expect(fresh.body).toMatchObject({ state: 'open', arrival: 'ip', session: false, account: null, vpnStatus: null });
    expect(fresh.headers['set-cookie']).toBeUndefined();

    const { code } = await t.store.record();
    await request(t.server).post('/bootstrap/claim').send({ code: 'AAAA-BBBB-CCCC', password: ADMIN }).expect(403);
    const claim = await request(t.server)
      .post('/bootstrap/claim')
      .send({ code: formatSetupCode(code).toLowerCase(), password: ADMIN })
      .expect(200);
    const setCookie = (claim.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('mp_onboarding='))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Secure/i);
    const cookie = onboardingCookie(claim);
    expect(t.state.adminPassword).toBe(ADMIN);

    const mine = await request(t.server).get('/bootstrap/status').set('Cookie', cookie).expect(200);
    // supertest's Host is 127.0.0.1 — loopback, so the endpoint falls back to DEVICE_IP
    expect(mine.body).toMatchObject({
      state: 'claimed', session: true, account: null, previousAccount: null, vpnStatus: 'not_installed',
      endpointSuggestion: '192.168.1.50',
    });
    const stranger = await request(t.server).get('/bootstrap/status').expect(200);
    expect(stranger.body).toMatchObject({ state: 'claimed', session: false, vpnStatus: null, endpointSuggestion: null });

    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', cookie)
      .send({ username: 'alex', password: 'personal-pass-12' })
      .expect(200);
    expect(t.state.users.get('alex')).toBe('personal-pass-12');

    await request(t.server)
      .post('/bootstrap/install')
      .set('Cookie', cookie)
      .send({ app: 'wg-easy', settings: { INIT_HOST: '203.0.113.7', INIT_PASSWORD: 'not-from-the-browser' } })
      .expect(200);
    expect(t.installed.install).toHaveBeenCalledWith('wg-easy', {
      settings: { INIT_HOST: '203.0.113.7', INIT_PASSWORD: ADMIN },
    });
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body.account).toBe('alex');

    // What the SSO callback runs (AuthController): the first sign-in since the claim.
    expect(await t.store.finishIfClaimed()).toBe(true);
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body).toMatchObject({
      state: 'finished', session: false, account: null,
    });
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).send({ username: 'alex' }).expect(401);
    await request(t.server).post('/bootstrap/install').set('Cookie', cookie).send({ app: 'wg-easy' }).expect(401);
    await request(t.server).get('/bootstrap/wireguard').set('Cookie', cookie).expect(401);
    await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(409);
    await request(t.server).post('/bootstrap/resume').send({ code }).expect(409);
  });

  it('a reset reopens onboarding with a new code and retires every older cookie', async () => {
    const first = (await t.store.record()).code;
    const cookie = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code: first, password: ADMIN }).expect(200),
    );
    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', cookie)
      .send({ username: 'alex', password: 'personal-pass-12' })
      .expect(200);

    const second = await t.store.reset(); // what `reset-onboarding` runs
    expect(second).not.toBe(first);
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body).toMatchObject({
      state: 'open', session: false,
    });
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).send({ username: 'alex' }).expect(401);
    await request(t.server).post('/bootstrap/claim').send({ code: first, password: 'new-admin-pass-12' }).expect(403);

    const fresh = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code: second, password: 'new-admin-pass-12' }).expect(200),
    );
    expect(t.state.adminPassword).toBe('new-admin-pass-12');
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', fresh)).body).toMatchObject({
      state: 'claimed', session: true, account: null, previousAccount: 'alex',
    });
    // The forgotten personal password: keep alex, set a new one.
    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', fresh)
      .send({ username: 'alex', password: 'brand-new-pass-12' })
      .expect(200);
    expect(t.state.users.get('alex')).toBe('brand-new-pass-12');
  });

  it('resume: the right code brings another browser back into a claimed setup', async () => {
    const { code } = await t.store.record();
    await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(200);
    await request(t.server).post('/bootstrap/resume').send({ code: 'AAAA-BBBB-CCCC' }).expect(403);
    const cookie = onboardingCookie(await request(t.server).post('/bootstrap/resume').send({ code }).expect(200));
    expect((await request(t.server).get('/bootstrap/status').set('Cookie', cookie)).body.session).toBe(true);
  });

  it('malformed or missing bodies are 4xx, never 500', async () => {
    const { code } = await t.store.record();
    await request(t.server).post('/bootstrap/claim').expect(403);
    await request(t.server).post('/bootstrap/claim').send({ code: 42, password: ADMIN }).expect(403);
    await request(t.server).post('/bootstrap/claim').send({ code, password: 123456789012 }).expect(400);
    await request(t.server).post('/bootstrap/claim').send({ code, password: 'elevenchars' }).expect(400);
    const cookie = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(200),
    );
    await request(t.server).post('/bootstrap/resume').expect(403);
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).expect(400);
    await request(t.server).post('/bootstrap/account').set('Cookie', cookie).send({ username: ['alex'] }).expect(400);
    await request(t.server).post('/bootstrap/install').set('Cookie', cookie).expect(400);
    await request(t.server).post('/bootstrap/install').set('Cookie', cookie).send({ app: '__proto__' }).expect(400);
    await request(t.server).post('/bootstrap/wireguard/peer').set('Cookie', cookie).send({ name: 42 }).expect(400);
    expect(t.installed.install).not.toHaveBeenCalled();
  });

  it('OpenBao down: status says waiting; resume and cookie-gated calls are 503', async () => {
    const { code } = await t.store.record();
    const cookie = onboardingCookie(
      await request(t.server).post('/bootstrap/claim').send({ code, password: ADMIN }).expect(200),
    );
    t.kv.failWith = new OpenBaoUnavailableError('sealed');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6_000); // past the store's 5-second cache
    expect((await request(t.server).get('/bootstrap/status')).body.state).toBe('waiting');
    await request(t.server).post('/bootstrap/resume').send({ code }).expect(503);
    await request(t.server)
      .post('/bootstrap/account')
      .set('Cookie', cookie)
      .send({ username: 'alex', password: 'personal-pass-12' })
      .expect(503);
  });

  it('Casdoor down before onboarding finishes: status says waiting', async () => {
    t.casdoor.reachable.mockResolvedValue(false);
    expect((await request(t.server).get('/bootstrap/status')).body.state).toBe('waiting');
  });
});
```

- [ ] **Step 7: Run unit tests, e2e and the typecheck**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm test && npm run test:e2e
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm run build
```
Expected:
- All unit tests pass.
- All e2e suites pass, including `Onboarding API (e2e)` (6 tests) and the existing `Auth (e2e)`, which now boots `OnboardingModule` inside `AppModule`.
- tsc exits 0 and the build succeeds.

- [ ] **Step 8: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/onboarding/bootstrap.controller.ts ui/packages/server/src/onboarding/bootstrap.controller.spec.ts ui/packages/server/src/onboarding/onboarding.module.ts ui/packages/server/src/app.module.ts ui/packages/server/test/onboarding.e2e-spec.ts
git commit -m "feat(ui): /api/bootstrap — status, claim, resume, account, VPN install and root CA"
git log --oneline -1
```

---
### Task 12: `reset-onboarding` command

**Files:**
- Create: `ui/packages/server/src/onboarding/reset-onboarding.ts`, `ui/packages/server/src/onboarding/reset-onboarding.cli.ts`
- Create: `ui/packages/server/bin/reset-onboarding` (executable)
- Modify: `ui/Dockerfile`
- Test: `ui/packages/server/src/onboarding/reset-onboarding.spec.ts`

**Interfaces:**
- Consumes: `OnboardingStore.reset()` (Task 5), `formatSetupCode` (Task 4), `OpenBaoClient`.
- Produces:
  - `runReset(store: Pick<OnboardingStore, 'reset'>, out: Pick<Console, 'log' | 'error'>): Promise<number>`: returns the exit code.
  - `/usr/local/bin/reset-onboarding` in the image, which runs `node /app/packages/server/dist/onboarding/reset-onboarding.cli.js`.

- [ ] **Step 1: Write the failing test**

Create `ui/packages/server/src/onboarding/reset-onboarding.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runReset } from './reset-onboarding';

describe('reset-onboarding', () => {
  it('prints the new setup code and exits 0', async () => {
    const out = { log: vi.fn(), error: vi.fn() };
    expect(await runReset({ reset: vi.fn(async () => '7KQMX3RT9VHC') }, out)).toBe(0);
    expect(out.log).toHaveBeenCalledWith(
      "LibrePod setup code: 7KQM-X3RT-9VHC — onboarding is open again; open http://<this device's IP> to continue",
    );
  });

  it('exits non-zero with the reason, and never prints a code, when OpenBao is unreachable', async () => {
    const out = { log: vi.fn(), error: vi.fn() };
    expect(await runReset({ reset: vi.fn(async () => { throw new Error('OpenBao unreachable: ECONNREFUSED'); }) }, out)).toBe(1);
    expect(out.error).toHaveBeenCalledWith('reset-onboarding failed: OpenBao unreachable: ECONNREFUSED');
    expect(out.log).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/reset-onboarding.spec.ts
```
Expected: FAIL, because `./reset-onboarding` does not exist.

- [ ] **Step 3: Implement**

Create `ui/packages/server/src/onboarding/reset-onboarding.ts`:

```ts
import type { OnboardingStore } from './onboarding-store';
import { formatSetupCode } from './setup-code';

/** `reset-onboarding` (spec §6): a new setup code and onboarding open again. Apps,
 * data, users and VPN peers stay. Returns the process exit code. */
export async function runReset(
  store: Pick<OnboardingStore, 'reset'>,
  out: Pick<Console, 'log' | 'error'>,
): Promise<number> {
  try {
    const code = await store.reset();
    out.log(
      `LibrePod setup code: ${formatSetupCode(code)} — onboarding is open again; open http://<this device's IP> to continue`,
    );
    return 0;
  } catch (err) {
    out.error(`reset-onboarding failed: ${(err as Error).message}`);
    return 1;
  }
}
```

Create `ui/packages/server/src/onboarding/reset-onboarding.cli.ts`:

```ts
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { OpenBaoClient } from '../installed/openbao.client';
import { OnboardingStore } from './onboarding-store';
import { runReset } from './reset-onboarding';

// `kubectl -n marketplace-ui exec deploy/marketplace-ui -- reset-onboarding` runs this
// (via /usr/local/bin/reset-onboarding). It signs in to OpenBao the way the server
// does — the pod's ServiceAccount, Kubernetes auth — with the container's env. The
// server caches the record for at most 5 s, so the reset lands without a restart.
const config = new ConfigService();
void runReset(new OnboardingStore(new OpenBaoClient(config), config), console).then((code) => process.exit(code));
```

Create `ui/packages/server/bin/reset-onboarding`:

```sh
#!/bin/sh
# Issues a new setup code and reopens first-run onboarding:
#   kubectl -n marketplace-ui exec deploy/marketplace-ui -- reset-onboarding
exec node /app/packages/server/dist/onboarding/reset-onboarding.cli.js "$@"
```

```bash
chmod 755 /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server/bin/reset-onboarding
```

In `ui/Dockerfile`, production stage, insert after the `COPY --from=builder /app/packages/shared/src ./packages/shared/src` line:

```dockerfile

# `kubectl -n marketplace-ui exec deploy/marketplace-ui -- reset-onboarding`: a new
# setup code, first-run onboarding open again (runs dist/onboarding/reset-onboarding.cli.js).
COPY --chmod=0755 packages/server/bin/reset-onboarding /usr/local/bin/reset-onboarding
```

- [ ] **Step 4: Run the test, then prove the built CLI starts and fails closed**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx vitest run src/onboarding/reset-onboarding.spec.ts
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm run build && test -f packages/server/dist/onboarding/reset-onboarding.cli.js && echo built
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && env -u OPENBAO_ADDR node packages/server/dist/onboarding/reset-onboarding.cli.js; echo "exit=$?"
```
Expected:
- PASS (2 tests).
- `built`.
- The CLI prints `reset-onboarding failed: OPENBAO_ADDR is not set` and then `exit=1`. This proves the compiled file loads, decorators and all, and refuses without OpenBao.

If Docker is available, also run:
```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && docker build -t marketplace-ui:reset-check . && docker run --rm --entrypoint sh marketplace-ui:reset-check -c 'ls -l /usr/local/bin/reset-onboarding && reset-onboarding; echo "exit=$?"'
```
Expected: an executable `reset-onboarding`, the same failure line, and `exit=1`. Skip this step if Docker is unavailable, and record the skip in your report.

- [ ] **Step 5: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/server/src/onboarding/reset-onboarding.ts ui/packages/server/src/onboarding/reset-onboarding.cli.ts ui/packages/server/src/onboarding/reset-onboarding.spec.ts ui/packages/server/bin/reset-onboarding ui/Dockerfile
git commit -m "feat(ui): reset-onboarding — a new setup code, onboarding reopened, apps and users kept"
git log --oneline -1
```

---

### Task 13: marketplace-ui manifests and version 0.9.0

**Files:**
- Modify (carry, then edit): `apps/marketplace-ui/base/configmap.yaml`
- Modify (carry): `apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml` (root CA mount, `ROOT_CA_PATH`)
- Modify (carry): `apps/marketplace-ui/metadata.yaml`, `apps/marketplace-ui/overlays/librepod/kustomization.yaml`, `infrastructure/system-apps/marketplace-ui.yaml`, `ui/package.json`, `ui/package-lock.json` (0.8.1 → 0.9.0)

**Interfaces:**
- Produces, as container env: `CASDOOR_BASE_URL`, `WGEASY_BASE_URL`, `CASDOOR_ADMIN_DEFAULT_PASSWORD` (configmap) and `ROOT_CA_PATH` (overlay). The root CA is mounted at `/mnt/root-ca`. The image, artifact and system-app pin all move to `0.9.0`.

- [ ] **Step 1: Carry**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git diff db77265 b42337c -- \
  apps/marketplace-ui/base/configmap.yaml \
  apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml \
  apps/marketplace-ui/metadata.yaml \
  apps/marketplace-ui/overlays/librepod/kustomization.yaml \
  infrastructure/system-apps/marketplace-ui.yaml \
  ui/package.json ui/package-lock.json \
  | git apply --3way
```

- [ ] **Step 2: Correct the factory-password comment for the new design**

In `apps/marketplace-ui/base/configmap.yaml`, replace

```yaml
  # The Casdoor built-in admin's factory password (same value the
  # casdoor-sso-controller env carries) — the wizard probes it to tell
  # onboarding mode from claimed, and randomizes it at claim time. wg-easy
  # needs no entry here: the wizard authenticates with wg-easy's own install
  # answer (OpenBao apps/wg-easy).
```

with

```yaml
  # Casdoor's factory admin password (the casdoor-sso-controller env carries the
  # same value). The claim signs in with it once and replaces it with the owner's
  # admin password, which then lives in OpenBao system/admin. wg-easy needs no
  # entry here: the wizard authenticates with wg-easy's own install answer
  # (OpenBao apps/wg-easy).
```

and replace

```yaml
  # In-cluster service URLs for first-run onboarding: the wizard proxies
  # Casdoor's admin API and wg-easy's API because the browser (raw IP, no DNS
  # yet) cannot reach either host. http, not https — cluster-internal traffic.
```

with

```yaml
  # In-cluster service URLs for first-run onboarding: the server calls Casdoor's
  # admin API and wg-easy's API on the browser's behalf (raw IP, no DNS yet).
  # http, not https — cluster-internal traffic.
```

- [ ] **Step 3: Verify the values and the manifests**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
grep -n '0.9.0' apps/marketplace-ui/metadata.yaml apps/marketplace-ui/overlays/librepod/kustomization.yaml infrastructure/system-apps/marketplace-ui.yaml ui/package.json
grep -c '"version": "0.9.0"' ui/package-lock.json
kustomize build apps/marketplace-ui/overlays/librepod | grep -E 'CASDOOR_BASE_URL|WGEASY_BASE_URL|CASDOOR_ADMIN_DEFAULT_PASSWORD|ROOT_CA_PATH|/mnt/root-ca|NODE_NAME'
kustomize build apps/marketplace-ui/overlays/librepod | kubeconform -strict -summary -ignore-missing-schemas -schema-location default
cd ui/packages/server && npx vitest run src/installed/rbac-manifest.spec.ts
```
Expected:
- Four files show `0.9.0`.
- The lock file count is at least 1.
- All six names appear in the build.
- kubeconform reports `Invalid: 0, Errors: 0`.
- The RBAC spec passes.

- [ ] **Step 4: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add apps/marketplace-ui/base/configmap.yaml apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml apps/marketplace-ui/metadata.yaml apps/marketplace-ui/overlays/librepod/kustomization.yaml infrastructure/system-apps/marketplace-ui.yaml ui/package.json ui/package-lock.json
git commit -m "feat(marketplace-ui): onboarding env and root CA mount; release 0.9.0"
git log --oneline -1
```

---
### Task 14: Wizard access steps — Welcome, Claim (setup code), Resume, Account

**Files:**
- Create: `ui/packages/client/src/pages/onboarding/api.ts`
- Create: `ui/packages/client/src/pages/onboarding/AccessSteps.tsx`
- Test: `ui/packages/client/src/pages/onboarding/AccessSteps.test.tsx`

**Interfaces:**
- Consumes: `POST /api/bootstrap/claim {code,password}`, `POST /api/bootstrap/resume {code}` and `POST /api/bootstrap/account {username,password?}` (Task 11).
- Produces:
  - `api.ts`:
    - `MIN_PASSWORD = 12`
    - `validPassword(p: string): boolean`
    - `SETUP_CODE_COMMAND`
    - `postJson(url: string, body: unknown): Promise<PostResult>` with `PostResult { ok; status; message: string | null; body: Record<string, unknown> }`
  - `AccessSteps.tsx`:
    - `WelcomeStep({ onBegin })`
    - `ClaimStep({ onClaimed })`
    - `ResumeScreen({ onResumed })`
    - `AccountStep({ baseDomain, previousAccount, onDone, onSessionLost })`

- [ ] **Step 1: Write the failing tests**

Create `ui/packages/client/src/pages/onboarding/AccessSteps.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { AccountStep, ClaimStep, ResumeScreen, WelcomeStep } from "@/pages/onboarding/AccessSteps"

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** Answers by URL; anything else gets 200 {}. */
function mockApi(routes: Record<string, Response> = {}) {
  return vi.spyOn(global, "fetch").mockImplementation(async (url) => routes[String(url)] ?? jsonResponse(200, {}))
}

function bodyOf(fetchMock: ReturnType<typeof mockApi>, url: string) {
  const call = fetchMock.mock.calls.find(([u]) => String(u) === url)
  return call ? JSON.parse(String(call[1]!.body)) : undefined
}

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe("WelcomeStep", () => {
  it("explains the steps and begins", () => {
    const onBegin = vi.fn()
    render(<WelcomeStep onBegin={onBegin} />)
    expect(screen.getByText(/welcome to your librepod/i)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /begin/i }))
    expect(onBegin).toHaveBeenCalled()
  })
})

describe("ClaimStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("needs a setup code and a valid, confirmed admin password", () => {
    render(<ClaimStep onClaimed={vi.fn()} />)
    const claim = screen.getByRole("button", { name: /claim this device/i })
    type("Admin password", "correct-horse-12")
    type("Confirm admin password", "correct-horse-12")
    expect(claim).toBeDisabled() // no code yet
    type("Setup code", "7KQM-X3RT-9VHC")
    expect(claim).toBeEnabled()
    type("Admin password", "elevenchars")
    type("Confirm admin password", "elevenchars")
    expect(claim).toBeDisabled()
    type("Admin password", "correct horse12")
    type("Confirm admin password", "correct horse12")
    expect(claim).toBeDisabled()
  })

  it("says where the code is", () => {
    render(<ClaimStep onClaimed={vi.fn()} />)
    expect(screen.getByText('kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"')).toBeInTheDocument()
  })

  it("posts the code and password, then hands over", async () => {
    const fetchMock = mockApi()
    const onClaimed = vi.fn()
    render(<ClaimStep onClaimed={onClaimed} />)
    type("Setup code", "7kqm-x3rt-9vhc")
    type("Admin password", "correct-horse-12")
    type("Confirm admin password", "correct-horse-12")
    fireEvent.click(screen.getByRole("button", { name: /claim this device/i }))
    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/claim")).toEqual({ code: "7kqm-x3rt-9vhc", password: "correct-horse-12" })
  })

  it("shows the server's reason and stays", async () => {
    mockApi({ "/api/bootstrap/claim": jsonResponse(403, { message: "That setup code isn't right" }) })
    const onClaimed = vi.fn()
    render(<ClaimStep onClaimed={onClaimed} />)
    type("Setup code", "AAAA-BBBB-CCCC")
    type("Admin password", "correct-horse-12")
    type("Confirm admin password", "correct-horse-12")
    fireEvent.click(screen.getByRole("button", { name: /claim this device/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup code isn't right")
    expect(onClaimed).not.toHaveBeenCalled()
  })
})

describe("ResumeScreen", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("posts the code and resumes", async () => {
    const fetchMock = mockApi()
    const onResumed = vi.fn()
    render(<ResumeScreen onResumed={onResumed} />)
    expect(screen.getByRole("heading", { name: /continue setting up/i })).toBeVisible()
    type("Setup code", "7KQM-X3RT-9VHC")
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    await vi.waitFor(() => expect(onResumed).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/resume")).toEqual({ code: "7KQM-X3RT-9VHC" })
  })

  it("a wrong code shows the reason", async () => {
    mockApi({ "/api/bootstrap/resume": jsonResponse(403, { message: "That setup code isn't right" }) })
    render(<ResumeScreen onResumed={vi.fn()} />)
    type("Setup code", "AAAA-BBBB-CCCC")
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That setup code isn't right")
  })
})

describe("AccountStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("a new account: lowercase username and a confirmed password", async () => {
    const fetchMock = mockApi()
    const onDone = vi.fn()
    render(<AccountStep baseDomain="libre.pod" previousAccount={null} onDone={onDone} onSessionLost={vi.fn()} />)
    type("Username", "Alex")
    expect(screen.getByText("alex@libre.pod")).toBeVisible()
    type("Password", "personal-pass-12")
    type("Confirm password", "personal-pass-12")
    fireEvent.click(screen.getByRole("button", { name: /create account/i }))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/account")).toEqual({ username: "alex", password: "personal-pass-12" })
  })

  it('"admin" and invalid characters are refused before posting', () => {
    render(<AccountStep baseDomain="libre.pod" previousAccount={null} onDone={vi.fn()} onSessionLost={vi.fn()} />)
    type("Password", "personal-pass-12")
    type("Confirm password", "personal-pass-12")
    const create = screen.getByRole("button", { name: /create account/i })
    for (const name of ["admin", "al ex", "al_ex", ""]) {
      type("Username", name)
      expect(create).toBeDisabled()
    }
  })

  it("after a reset: keep the account as is — no password sent", async () => {
    const fetchMock = mockApi()
    const onDone = vi.fn()
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={onDone} onSessionLost={vi.fn()} />)
    expect(screen.getByLabelText(/keep alex/i)).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/account")).toEqual({ username: "alex" })
  })

  it("after a reset: keep the account with a new password (the forgotten-password recovery)", async () => {
    const fetchMock = mockApi()
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={vi.fn()} onSessionLost={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/set a new password for alex/i))
    const go = screen.getByRole("button", { name: /^continue$/i })
    expect(go).toBeDisabled()
    type("Password", "brand-new-pass-12")
    type("Confirm password", "brand-new-pass-12")
    fireEvent.click(go)
    await vi.waitFor(() =>
      expect(bodyOf(fetchMock, "/api/bootstrap/account")).toEqual({ username: "alex", password: "brand-new-pass-12" }),
    )
  })

  it("after a reset: a different account shows the username field", () => {
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={vi.fn()} onSessionLost={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/create a different account/i))
    expect(screen.getByLabelText("Username")).toBeVisible()
  })

  it("a lost setup session (401) hands back to the page", async () => {
    mockApi({ "/api/bootstrap/account": jsonResponse(401, { message: "Unauthorized" }) })
    const onSessionLost = vi.fn()
    render(<AccountStep baseDomain="libre.pod" previousAccount="alex" onDone={vi.fn()} onSessionLost={onSessionLost} />)
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/client && npx vitest run src/pages/onboarding/AccessSteps.test.tsx
```
Expected: FAIL, because `@/pages/onboarding/AccessSteps` does not exist.

- [ ] **Step 3: Implement `api.ts`**

Create `ui/packages/client/src/pages/onboarding/api.ts`:

```ts
/** The admin and personal password rule, mirrored from the server: 12+ characters,
 *  no whitespace (wg-easy rejects shorter admin passwords; Casdoor rejects spaces). */
export const MIN_PASSWORD = 12

export function validPassword(p: string): boolean {
  return p.length >= MIN_PASSWORD && !/\s/.test(p)
}

/** Where the setup code is printed — any shell with kubectl access to the device. */
export const SETUP_CODE_COMMAND = 'kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"'

export interface PostResult {
  ok: boolean
  status: number
  /** The server's message, when it sent one as text. */
  message: string | null
  body: Record<string, unknown>
}

/** POSTs JSON to a wizard endpoint. Plain fetch on purpose — apiFetch's 401 handler
 *  redirects into single sign-on, which cannot work on the raw IP. */
export async function postJson(url: string, body: unknown): Promise<PostResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return {
    ok: res.ok,
    status: res.status,
    message: typeof parsed.message === "string" ? parsed.message : null,
    body: parsed,
  }
}
```

- [ ] **Step 4: Implement `AccessSteps.tsx`**

Create `ui/packages/client/src/pages/onboarding/AccessSteps.tsx`:

```tsx
import { useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MIN_PASSWORD, SETUP_CODE_COMMAND, postJson, validPassword } from "./api"

/** Mirrors the server's username rule. */
const USERNAME = /^[a-z0-9.-]{1,39}$/

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function WelcomeStep({ onBegin }: { onBegin: () => void }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Welcome to your LibrePod</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        You are on the device's raw address — that is how every LibrePod starts. In a few
        minutes this setup gives it an owner, your own sign-in, and a way for your phone
        and laptop to reach it by name.
      </p>
      <ul className="mt-4 space-y-1 text-sm text-muted-foreground">
        <li>1 · Claim it — the setup code and an admin password</li>
        <li>2 · Your account — the sign-in you use every day</li>
        <li>3 · Reach it — WireGuard, or your own connectivity</li>
        <li>4 · Trust it — install its root certificate</li>
      </ul>
      <Button className="mt-6" onClick={onBegin}>Begin</Button>
    </section>
  )
}

function SetupCodeField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">Setup code</label>
      <Input id={id} className="mt-1 font-mono uppercase" placeholder="XXXX-XXXX-XXXX" autoComplete="off"
        autoCapitalize="characters" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer text-foreground">Where do I find it?</summary>
        <p className="mt-2">It is printed in this device's log. On a computer with access to the device, run:</p>
        <code className="mt-1 block break-all rounded bg-muted p-2">{SETUP_CODE_COMMAND}</code>
      </details>
    </div>
  )
}

function PasswordFields({ idPrefix, label, password, confirm, setPassword, setConfirm }: {
  idPrefix: string
  label: string
  password: string
  confirm: string
  setPassword: (v: string) => void
  setConfirm: (v: string) => void
}) {
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-password`} className="text-sm font-medium">{label}</label>
        <Input id={`${idPrefix}-password`} type="password" className="mt-1" autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="mt-1 text-xs text-muted-foreground">At least {MIN_PASSWORD} characters, no spaces.</p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-confirm`} className="text-sm font-medium">Confirm {label.toLowerCase()}</label>
        <Input id={`${idPrefix}-confirm`} type="password" className="mt-1" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {confirm !== "" && password !== confirm && (
          <p className="mt-1 text-xs text-destructive">Passwords do not match</p>
        )}
      </div>
    </>
  )
}

/** The setup code proves ownership; the admin password becomes the device's master key. */
export function ClaimStep({ onClaimed }: { onClaimed: () => void }) {
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = code.trim() !== "" && validPassword(password) && password === confirm

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/claim", { code, password })
      if (res.ok) {
        onClaimed()
        return
      }
      setError(res.message ?? `claiming failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Claim your device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        The setup code proves this device is yours. Then set the admin password — the master
        key for this device, and the default admin password of apps that ship one. Keep it
        somewhere safe.
      </p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <SetupCodeField id="claim-code" value={code} onChange={setCode} />
        <PasswordFields idPrefix="claim" label="Admin password" password={password} confirm={confirm}
          setPassword={setPassword} setConfirm={setConfirm} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !ready}>{busy ? "Claiming…" : "Claim this device"}</Button>
      </form>
    </section>
  )
}

/** Claimed, but this browser isn't part of the setup yet (a new browser, or its
 *  setup cookie expired): the setup code lets it back in. */
export function ResumeScreen({ onResumed }: { onResumed: () => void }) {
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/resume", { code })
      if (res.ok) {
        onResumed()
        return
      }
      setError(res.message ?? `checking the code failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Continue setting up</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This device is claimed, but setup isn't finished — and this browser isn't part of it
        yet. Enter the setup code to pick up where you left off.
      </p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <SetupCodeField id="resume-code" value={code} onChange={setCode} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || code.trim() === ""}>{busy ? "Checking…" : "Continue"}</Button>
      </form>
    </section>
  )
}

/** The personal account for daily sign-in. After a reset, the account from before
 *  can be kept — optionally with a new password (the forgotten-password recovery). */
export function AccountStep({ baseDomain, previousAccount, onDone, onSessionLost }: {
  baseDomain: string
  previousAccount: string | null
  onDone: () => void
  onSessionLost: () => void
}) {
  const [mode, setMode] = useState<"keep" | "new">(previousAccount ? "keep" : "new")
  const [username, setUsername] = useState("")
  const [changePassword, setChangePassword] = useState(false)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const keeping = mode === "keep" && previousAccount != null
  const name = keeping ? (previousAccount ?? "") : username
  const needsPassword = !keeping || changePassword
  const ready =
    USERNAME.test(name) && name !== "admin" && (!needsPassword || (validPassword(password) && password === confirm))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/account", needsPassword ? { username: name, password } : { username: name })
      if (res.ok) {
        onDone()
        return
      }
      if (res.status === 401) {
        onSessionLost()
        return
      }
      setError(res.message ?? `saving the account failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This is how you sign in every day — here and in every app you install. Keep{" "}
        <span className="font-mono">admin</span> for emergencies.
      </p>
      {previousAccount && (
        <fieldset className="mt-4 space-y-2 text-sm">
          <legend className="sr-only">Account</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="account-mode" checked={mode === "keep"} onChange={() => setMode("keep")} />
            Keep <span className="font-mono">{previousAccount}</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="account-mode" checked={mode === "new"} onChange={() => setMode("new")} />
            Create a different account
          </label>
        </fieldset>
      )}
      <form className="mt-6 space-y-4" onSubmit={submit}>
        {keeping ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={changePassword} onChange={(e) => setChangePassword(e.target.checked)} />
            Set a new password for {previousAccount}
          </label>
        ) : (
          <div>
            <label htmlFor="account-username" className="text-sm font-medium">Username</label>
            <Input id="account-username" className="mt-1" autoComplete="username" autoCapitalize="none"
              spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
            <p className="mt-1 text-xs text-muted-foreground">
              Lowercase letters, digits, dots and dashes. You will sign in as{" "}
              <span className="font-mono">{username || "name"}@{baseDomain}</span>.
            </p>
          </div>
        )}
        {needsPassword && (
          <PasswordFields idPrefix="account" label="Password" password={password} confirm={confirm}
            setPassword={setPassword} setConfirm={setConfirm} />
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Saving…" : keeping ? "Continue" : "Create account"}
        </Button>
      </form>
    </section>
  )
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/client && npx vitest run src/pages/onboarding/AccessSteps.test.tsx
```
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/client/src/pages/onboarding/api.ts ui/packages/client/src/pages/onboarding/AccessSteps.tsx ui/packages/client/src/pages/onboarding/AccessSteps.test.tsx
git commit -m "feat(ui): wizard welcome, claim with the setup code, resume, and the personal account"
git log --oneline -1
```

---
### Task 15: Wizard connectivity steps — VPN (two paths), Trust, Connect (with fallback), Graduate

**Files:**
- Create: `ui/packages/client/src/pages/onboarding/ConnectivitySteps.tsx` (Trust, `usePeers` and `PeerPanel` carried from #215's `OnboardingPage.tsx`; the rest rewritten)
- Test: `ui/packages/client/src/pages/onboarding/ConnectivitySteps.test.tsx`

**Interfaces:**
- Consumes:
  - `postJson` from `./api` (Task 14).
  - `OnboardingStatus`, `WgPeer`, `InstallValidationErrorBody` from `@librepod/shared`.
  - `POST /api/bootstrap/install`, `GET /api/bootstrap/wireguard`, `POST /api/bootstrap/wireguard/peer`, and the QR and config URLs (Tasks 9 and 11).
- Produces:
  - `type ConnectivityPath = "wireguard" | "own"` and `STUCK_AFTER_MS = 300000`.
  - Components:
    - `VpnStep({ status, onWireguard, onOwn, onSessionLost })`
    - `TrustStep({ onDone })`
    - `ConnectStep({ status, onConnected, onUseOwn, onSessionLost })`
    - `GraduateStep({ status, path, onAnotherDevice })`

- [ ] **Step 1: Write the failing tests**

Create `ui/packages/client/src/pages/onboarding/ConnectivitySteps.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, render, screen, fireEvent } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import { ConnectStep, GraduateStep, STUCK_AFTER_MS, TrustStep, VpnStep } from "@/pages/onboarding/ConnectivitySteps"

const status: OnboardingStatus = {
  state: "claimed", arrival: "ip", baseDomain: "libre.pod", session: true, account: "alex",
  previousAccount: null, vpnStatus: "not_installed", peerCount: null, lastHandshakeAt: null,
  endpointSuggestion: "192.168.1.50",
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}
function mockApi(routes: Record<string, Response> = {}) {
  return vi.spyOn(global, "fetch").mockImplementation(async (url) => routes[String(url)] ?? jsonResponse(200, {}))
}
function bodyOf(fetchMock: ReturnType<typeof mockApi>, url: string) {
  const call = fetchMock.mock.calls.find(([u]) => String(u) === url)
  return call ? JSON.parse(String(call[1]!.body)) : undefined
}
const noop = () => {}

describe("VpnStep", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("pre-fills the endpoint and installs WireGuard with it — never a password", async () => {
    const fetchMock = mockApi()
    const onWireguard = vi.fn()
    render(<VpnStep status={status} onWireguard={onWireguard} onOwn={noop} onSessionLost={noop} />)
    expect(screen.getByLabelText("Endpoint host")).toHaveValue("192.168.1.50")
    fireEvent.change(screen.getByLabelText("Endpoint host"), { target: { value: " 203.0.113.7 " } })
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await vi.waitFor(() => expect(onWireguard).toHaveBeenCalled())
    expect(bodyOf(fetchMock, "/api/bootstrap/install")).toEqual({ app: "wg-easy", settings: { INIT_HOST: "203.0.113.7" } })
  })

  it("an empty endpoint disables the install", () => {
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={noop} />)
    fireEvent.change(screen.getByLabelText("Endpoint host"), { target: { value: "  " } })
    expect(screen.getByRole("button", { name: /set up wireguard/i })).toBeDisabled()
  })

  it("a 409 (already installed — e.g. a retry) counts as success", async () => {
    mockApi({ "/api/bootstrap/install": jsonResponse(409, { message: "WG Easy is already installed" }) })
    const onWireguard = vi.fn()
    render(<VpnStep status={status} onWireguard={onWireguard} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await vi.waitFor(() => expect(onWireguard).toHaveBeenCalled())
  })

  it("an endpoint field error shows under the field; other errors show the server message", async () => {
    mockApi({
      "/api/bootstrap/install": jsonResponse(400, {
        message: "Some settings need attention", errors: [{ name: "INIT_HOST", message: "Too long (max 16 KiB)" }],
      }),
    })
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Too long (max 16 KiB)")
  })

  it("a retryable server message (503) is shown and the step stays", async () => {
    mockApi({ "/api/bootstrap/install": jsonResponse(503, { message: "Couldn't determine this device's address. Try again in a minute." }) })
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again in a minute/i)
    expect(screen.getByRole("heading", { name: /reach your librepod by name/i })).toBeVisible()
  })

  it('"I\'ll bring my own" takes the other path', () => {
    const onOwn = vi.fn()
    render(<VpnStep status={status} onWireguard={noop} onOwn={onOwn} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    expect(onOwn).toHaveBeenCalled()
  })

  it("already installed: just continue", () => {
    const onWireguard = vi.fn()
    render(<VpnStep status={{ ...status, vpnStatus: "running" }} onWireguard={onWireguard} onOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(onWireguard).toHaveBeenCalled()
  })

  it("a lost setup session (401) hands back to the page", async () => {
    mockApi({ "/api/bootstrap/install": jsonResponse(401, {}) })
    const onSessionLost = vi.fn()
    render(<VpnStep status={status} onWireguard={noop} onOwn={noop} onSessionLost={onSessionLost} />)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalled())
  })
})

describe("TrustStep", () => {
  beforeEach(() => localStorage.clear())

  it("offers the root CA and continues once installed", () => {
    const onDone = vi.fn()
    render(<TrustStep onDone={onDone} />)
    expect(screen.getByRole("link", { name: /download root certificate/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    const go = screen.getByRole("button", { name: /continue/i })
    expect(go).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(go)
    expect(onDone).toHaveBeenCalled()
  })
})

describe("ConnectStep", () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.useRealTimers())

  it("installing: progress, no key form, no peer polling", () => {
    const fetchMock = mockApi()
    render(<ConnectStep status={{ ...status, vpnStatus: "installing", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    expect(screen.getByText(/setting up wireguard/i)).toBeVisible()
    expect(screen.queryByRole("button", { name: /create connection key/i })).toBeNull()
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/bootstrap/wireguard")).toBe(false)
  })

  it("error: WireGuard couldn't start — offers my own connectivity", () => {
    mockApi()
    const onUseOwn = vi.fn()
    render(<ConnectStep status={{ ...status, vpnStatus: "error", peerCount: 0 }} onConnected={noop} onUseOwn={onUseOwn} onSessionLost={noop} />)
    expect(screen.getByText(/couldn't start on this device/i)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /use my own connectivity instead/i }))
    expect(onUseOwn).toHaveBeenCalled()
  })

  it("installing for more than five minutes: the same fallback", () => {
    vi.useFakeTimers()
    mockApi()
    render(<ConnectStep status={{ ...status, vpnStatus: "installing", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    expect(screen.queryByText(/couldn't start on this device/i)).toBeNull()
    act(() => { vi.advanceTimersByTime(STUCK_AFTER_MS + 10_000) })
    expect(screen.getByRole("button", { name: /use my own connectivity instead/i })).toBeVisible()
  })

  it("running, no peers: creates a key and swaps the form for the QR", async () => {
    let peers: unknown[] = []
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url) === "/api/bootstrap/wireguard/peer") {
        peers = [{ clientId: "c1", name: "phone", enabled: true, latestHandshakeAt: null }]
        return jsonResponse(200, { clientId: "c1", name: "phone" })
      }
      return jsonResponse(200, { peers })
    })
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    fireEvent.change(await screen.findByLabelText(/name this device/i), { target: { value: "phone" } })
    fireEvent.click(screen.getByRole("button", { name: /create connection key/i }))
    expect(await screen.findByAltText(/QR for phone/i)).toHaveAttribute("src", "/api/bootstrap/wireguard/clients/c1/qrcode.svg")
  })

  it("the server's message reaches the user instead of a bare status code", async () => {
    mockApi({
      "/api/bootstrap/wireguard": jsonResponse(200, { peers: [] }),
      "/api/bootstrap/wireguard/peer": jsonResponse(503, { message: "WireGuard rejected its admin password — it was changed in WireGuard itself." }),
    })
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 0 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    fireEvent.click(await screen.findByRole("button", { name: /create connection key/i }))
    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected its admin password/i)
  })

  it("with peers: the QR, plus a way to add another device", async () => {
    mockApi({
      "/api/bootstrap/wireguard": jsonResponse(200, { peers: [{ clientId: "c1", name: "phone", enabled: true, latestHandshakeAt: null }] }),
    })
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 1 }} onConnected={noop} onUseOwn={noop} onSessionLost={noop} />)
    expect(await screen.findByAltText(/QR for phone/i)).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /add another device/i }))
    expect(screen.getByRole("button", { name: /create connection key/i })).toBeVisible()
  })

  it("a handshake enables Continue", () => {
    mockApi()
    const onConnected = vi.fn()
    render(<ConnectStep status={{ ...status, vpnStatus: "running", peerCount: 1, lastHandshakeAt: "2026-10-14T10:00:00Z" }} onConnected={onConnected} onUseOwn={noop} onSessionLost={noop} />)
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    expect(onConnected).toHaveBeenCalled()
  })
})

describe("GraduateStep", () => {
  it("WireGuard path: open the domain and sign in with the personal account", () => {
    const onAnotherDevice = vi.fn()
    render(<GraduateStep status={status} path="wireguard" onAnotherDevice={onAnotherDevice} />)
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    expect(screen.getByText("alex@libre.pod")).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /connect another device/i }))
    expect(onAnotherDevice).toHaveBeenCalled()
  })

  it("bring-my-own path: the checklist", () => {
    render(<GraduateStep status={status} path="own" onAnotherDevice={noop} />)
    const list = screen.getByRole("list", { name: /before you sign in/i })
    expect(list).toHaveTextContent("*.libre.pod")
    expect(list).toHaveTextContent(/root certificate/i)
    expect(list).toHaveTextContent("alex@libre.pod")
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/client && npx vitest run src/pages/onboarding/ConnectivitySteps.test.tsx
```
Expected: FAIL, because `@/pages/onboarding/ConnectivitySteps` does not exist.

- [ ] **Step 3: Implement**

Create `ui/packages/client/src/pages/onboarding/ConnectivitySteps.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react"
import type { InstallValidationErrorBody, OnboardingStatus, WgPeer } from "@librepod/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { postJson } from "./api"

/** "wireguard" = the wizard installs wg-easy; "own" = the owner brings their own
 *  connectivity (Tailscale/Headscale, a tunnel, their own DNS). Page state only. */
export type ConnectivityPath = "wireguard" | "own"

/** The VPN app the wizard installs (server allowlist: POST /api/bootstrap/install). */
const VPN_APP = "wg-easy"
/** Installing longer than this on this page means WireGuard isn't coming up here. */
export const STUCK_AFTER_MS = 5 * 60 * 1000

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** "Reach your LibrePod by name": WireGuard (recommended) or "I'll bring my own".
 *  The server answers wg-easy's admin-password question itself; the browser sends
 *  only the endpoint the owner confirmed. */
export function VpnStep({ status, onWireguard, onOwn, onSessionLost }: {
  status: OnboardingStatus
  onWireguard: () => void
  onOwn: () => void
  onSessionLost: () => void
}) {
  const [endpoint, setEndpoint] = useState(status.endpointSuggestion ?? "")
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const installed = status.vpnStatus != null && status.vpnStatus !== "not_installed"

  async function install() {
    setBusy(true); setError(null); setFieldError(null)
    try {
      const res = await postJson("/api/bootstrap/install", { app: VPN_APP, settings: { INIT_HOST: endpoint.trim() } })
      // 409 = already installed (e.g. a retry after a lost response): same outcome.
      if (res.ok || res.status === 409) {
        onWireguard()
        return
      }
      if (res.status === 401) {
        onSessionLost()
        return
      }
      const errors = (res.body as Partial<InstallValidationErrorBody>).errors
      const onField = errors?.find((e) => e.name === "INIT_HOST")?.message
      if (onField) setFieldError(onField)
      else setError(errors?.[0]?.message ?? res.message ?? `setting up WireGuard failed (${res.status})`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Reach your LibrePod by name</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Nothing on your network knows <span className="font-mono">{status.baseDomain}</span> yet. Choose how
        your phone and laptop will reach it.
      </p>
      {installed ? (
        <div className="mt-6">
          <p className="text-sm text-muted-foreground">✓ WireGuard is installed.</p>
          <Button className="mt-4" onClick={onWireguard}>Continue</Button>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm font-medium">WireGuard <span className="text-muted-foreground">(recommended)</span></p>
            <p className="mt-1 text-sm text-muted-foreground">
              A private tunnel to this device. Once your phone or laptop is connected, every{" "}
              <span className="font-mono">*.{status.baseDomain}</span> address works.
            </p>
            <label htmlFor="vpn-endpoint" className="mt-4 block text-sm font-medium">Endpoint host</label>
            <Input id="vpn-endpoint" className="mt-1 font-mono" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">
              The address your devices dial — this device's address as they see it. On a cloud server, its public IP.
            </p>
            {fieldError && <p role="alert" className="mt-1 text-xs text-destructive">{fieldError}</p>}
            {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
            <Button className="mt-4" onClick={install} disabled={busy || endpoint.trim() === ""}>
              {busy ? "Setting up…" : "Set up WireGuard"}
            </Button>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm font-medium">I'll bring my own</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Already using Tailscale, Headscale, a tunnel or your own DNS? Skip WireGuard and point{" "}
              <span className="font-mono">{status.baseDomain}</span> and{" "}
              <span className="font-mono">*.{status.baseDomain}</span> at this device yourself.
            </p>
            <Button className="mt-4" variant="outline" onClick={onOwn}>I'll bring my own</Button>
          </div>
        </div>
      )}
    </section>
  )
}

export function TrustStep({ onDone }: { onDone: () => void }) {
  const [installed, setInstalled] = useState(localStorage.getItem("librepod-onboarding-ca") === "1")
  return (
    <section>
      <h1 className="text-2xl font-semibold">Trust your device</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your device issues its own certificates. Installing this root certificate on your
        phone and laptop now means every address ends in a clean padlock, starting with the
        next step.
      </p>
      <Button className="mt-6" render={<a href="/api/bootstrap/ca" download />}>
        Download root certificate
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

/** WireGuard isn't coming up: an error, or still installing STUCK_AFTER_MS after this
 *  step appeared. Either way the owner may switch to their own connectivity. */
function useStuck(vpnStatus: OnboardingStatus["vpnStatus"]): boolean {
  const [since] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const installing = vpnStatus === "installing"
  useEffect(() => {
    if (!installing) return
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [installing])
  return vpnStatus === "error" || (installing && now - since >= STUCK_AFTER_MS)
}

export function ConnectStep({ status, onConnected, onUseOwn, onSessionLost }: {
  status: OnboardingStatus
  onConnected: () => void
  onUseOwn: () => void
  onSessionLost: () => void
}) {
  const [name, setName] = useState("")
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stuck = useStuck(status.vpnStatus)
  // Flux is still rolling wg-easy out (or retrying a failed rollout): nothing to create yet.
  const settingUp = status.vpnStatus === "installing" || status.vpnStatus === "error"
  const { peers, refresh } = usePeers(!settingUp)
  const list = peers ?? []
  const connected = !!status.lastHandshakeAt

  async function createPeer() {
    setBusy(true); setError(null)
    try {
      const res = await postJson("/api/bootstrap/wireguard/peer", { name: name || "my-device" })
      if (res.status === 401) {
        onSessionLost()
        return
      }
      if (!res.ok) throw new Error(res.message ?? `creating the key failed (${res.status})`)
      setName("")
      setAdding(false)
      await refresh() // swap the form for the QR at once — waiting for the 5s tick invites duplicate peers
    } catch (err) {
      setError(errorText(err))
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
      {stuck ? (
        <div className="mt-6 rounded-lg border border-border p-4 text-sm">
          <p className="font-medium">WireGuard couldn't start on this device</p>
          <p className="mt-2 text-muted-foreground">
            Some networks and clusters block what it needs — UDP port 51820, or a kernel setting.
            You can keep waiting, or use your own connectivity instead. WireGuard stays installed;
            you can remove it from the catalog later.
          </p>
          <Button className="mt-3" onClick={onUseOwn}>Use my own connectivity instead</Button>
        </div>
      ) : settingUp ? (
        <div className="mt-6 rounded-lg border border-border p-4">
          <p className="flex items-center gap-2 text-sm">
            <span aria-hidden className="inline-block size-2 animate-pulse rounded-full bg-muted-foreground/40" />
            Setting up WireGuard… this takes a minute or two.
          </p>
        </div>
      ) : (
        <>
          {list.length === 0 || adding ? (
            <div className="mt-6 space-y-3">
              <label htmlFor="peer-name" className="text-sm font-medium">Name this device (e.g. “phone”)</label>
              <Input id="peer-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="phone" />
              <Button onClick={createPeer} disabled={busy}>{busy ? "Creating…" : "Create connection key"}</Button>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
          ) : (
            <>
              <PeerPanel peers={list} />
              <button className="mt-3 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdding(true)}>
                Add another device
              </button>
            </>
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
              <button className="ml-3 text-xs text-muted-foreground hover:text-foreground" onClick={onConnected}>
                Skip — I’ll connect later
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** Polls the peer list only while Connect can show it (`enabled`). `refresh` lets a
 *  successful create swap the form for the QR without waiting for the 5s tick. */
function usePeers(enabled: boolean): { peers: WgPeer[] | undefined; refresh: () => Promise<void> } {
  const [peers, setPeers] = useState<WgPeer[] | undefined>(undefined)
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/bootstrap/wireguard")
      if (res.ok) setPeers(((await res.json()) as { peers: WgPeer[] }).peers)
    } catch { /* transient — the interval retries */ }
  }, [])
  useEffect(() => {
    if (!enabled) return
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
  }, [enabled])
  return { peers, refresh }
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

/** The hand-off to the domain. The first sign-in there finishes onboarding; the page
 *  notices (status polling) and RootGate switches to UseDomainScreen. */
export function GraduateStep({ status, path, onAnotherDevice }: {
  status: OnboardingStatus
  path: ConnectivityPath
  onAnotherDevice: () => void
}) {
  const url = `https://${status.baseDomain}`
  const signIn = `${status.account ?? "your account"}@${status.baseDomain}`
  if (path === "own") {
    return (
      <section>
        <p className="text-sm text-muted-foreground">Almost there. Your device's name:</p>
        <h1 className="mt-2 font-mono text-3xl font-semibold break-all">{status.baseDomain}</h1>
        <ul className="mt-4 space-y-2 text-sm text-muted-foreground" aria-label="before you sign in">
          <li>
            ☐ <span className="font-mono">{status.baseDomain}</span> and <span className="font-mono">*.{status.baseDomain}</span>{" "}
            resolve to this device from your devices — through your VPN, tunnel or DNS.
          </li>
          <li>☐ The root certificate is trusted on those devices.</li>
          <li>☐ Open <span className="font-mono">{url}</span> and sign in as <span className="font-mono">{signIn}</span>.</li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">This page notices your first sign-in and finishes setup.</p>
        <Button className="mt-6" render={<a href={url} />}>Open {status.baseDomain}</Button>
      </section>
    )
  }
  return (
    <section className="text-center">
      <p className="text-sm text-muted-foreground">Your device now has a name.</p>
      <h1 className="mt-2 font-mono text-3xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        With the WireGuard tunnel on, open <span className="font-mono">{url}</span> and sign in as{" "}
        <span className="font-mono">{signIn}</span>. That first sign-in finishes setup — from then on,
        this raw address only points you to your device's name.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button render={<a href={url} />}>Open {status.baseDomain}</Button>
        <Button variant="outline" onClick={onAnotherDevice}>Connect another device</Button>
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/client && npx vitest run src/pages/onboarding/ConnectivitySteps.test.tsx
```
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/client/src/pages/onboarding/ConnectivitySteps.tsx ui/packages/client/src/pages/onboarding/ConnectivitySteps.test.tsx
git commit -m "feat(ui): wizard connectivity — WireGuard with a confirmed endpoint or bring your own, trust, connect, graduate"
git log --oneline -1
```

---
### Task 16: Wizard page — step derivation and both paths

**Files:**
- Create: `ui/packages/client/src/pages/onboarding/OnboardingPage.tsx`
- Test: `ui/packages/client/src/pages/onboarding/OnboardingPage.test.tsx`

**Interfaces:**
- Consumes:
  - `WelcomeStep`, `ClaimStep`, `ResumeScreen`, `AccountStep` (Task 14).
  - `VpnStep`, `TrustStep`, `ConnectStep`, `GraduateStep`, `ConnectivityPath` (Task 15).
  - `OnboardingStatus`.
- Produces:
  - `OnboardingPage({ status, onRefresh }: { status: OnboardingStatus; onRefresh: () => void })`.
  - `deriveStep(s: OnboardingStatus): number`.
  - Step constants `WELCOME=0`, `CLAIM=1`, `ACCOUNT=2`, `VPN=3`, `TRUST=4`, `CONNECT=5`, `GRADUATE=6`.

- [ ] **Step 1: Write the failing tests**

Create `ui/packages/client/src/pages/onboarding/OnboardingPage.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import {
  ACCOUNT, CLAIM, CONNECT, GRADUATE, OnboardingPage, TRUST, VPN, deriveStep,
} from "@/pages/onboarding/OnboardingPage"

const open: OnboardingStatus = {
  state: "open", arrival: "ip", baseDomain: "libre.pod", session: false, account: null, previousAccount: null,
  vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
}
const claimed: OnboardingStatus = {
  ...open, state: "claimed", session: true, account: "alex", vpnStatus: "not_installed", endpointSuggestion: "192.168.1.50",
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}
const mockApi = () => vi.spyOn(global, "fetch").mockImplementation(async () => jsonResponse(200, {}))
const page = (status: OnboardingStatus, onRefresh = vi.fn()) => render(<OnboardingPage status={status} onRefresh={onRefresh} />)
const vpnHeading = () => screen.getByRole("heading", { name: /reach your librepod by name/i })

describe("deriveStep — cluster truth decides the step", () => {
  it.each([
    ["open", open, CLAIM],
    ["claimed, no account confirmed", { ...claimed, account: null }, ACCOUNT],
    ["VPN not installed", claimed, VPN],
    ["VPN status unknown", { ...claimed, vpnStatus: null }, VPN],
    ["installing, no peers", { ...claimed, vpnStatus: "installing" as const, peerCount: 0 }, TRUST],
    ["running, no peers", { ...claimed, vpnStatus: "running" as const, peerCount: 0 }, TRUST],
    ["error, no peers", { ...claimed, vpnStatus: "error" as const, peerCount: 0 }, TRUST],
    ["a peer, no handshake", { ...claimed, vpnStatus: "running" as const, peerCount: 1 }, CONNECT],
    ["a handshake", { ...claimed, vpnStatus: "running" as const, peerCount: 1, lastHandshakeAt: "2026-10-14T10:00:00Z" }, GRADUATE],
  ])("%s", (_name, status, step) => {
    expect(deriveStep(status)).toBe(step)
  })
})

describe("OnboardingPage", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it("a fresh device starts at Welcome, then Claim", () => {
    page(open)
    fireEvent.click(screen.getByRole("button", { name: /begin/i }))
    expect(screen.getByRole("heading", { name: /claim your device/i })).toBeVisible()
  })

  it("claimed, but this browser has no setup session → Resume", () => {
    page({ ...claimed, session: false })
    expect(screen.getByRole("heading", { name: /continue setting up/i })).toBeVisible()
  })

  it("after a reset the Account step offers to keep the old account", () => {
    page({ ...claimed, account: null, previousAccount: "alex" })
    expect(screen.getByLabelText(/keep alex/i)).toBeChecked()
  })

  it("WireGuard path: VPN → Trust → Connect", async () => {
    mockApi()
    const onRefresh = vi.fn()
    page(claimed, onRefresh)
    fireEvent.click(screen.getByRole("button", { name: /set up wireguard/i }))
    await screen.findByRole("heading", { name: /trust your device/i })
    expect(onRefresh).toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(screen.getByRole("heading", { name: /connect your first device/i })).toBeVisible()
  })

  it("bring-my-own path: VPN → Trust → Graduate checklist, no Connect", () => {
    page(claimed)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    expect(screen.getByRole("list", { name: /before you sign in/i })).toBeVisible()
    expect(screen.queryByRole("heading", { name: /connect your first device/i })).toBeNull()
  })

  it("the path is page state: a reload asks again", () => {
    const { unmount } = page(claimed)
    fireEvent.click(screen.getByRole("button", { name: /i'll bring my own/i }))
    unmount()
    page(claimed)
    expect(vpnHeading()).toBeVisible()
  })

  it("WireGuard couldn't start: Connect falls back to the bring-my-own Graduate", () => {
    mockApi()
    page({ ...claimed, vpnStatus: "error", peerCount: 0 })
    fireEvent.click(screen.getByLabelText(/i installed the certificate/i))
    fireEvent.click(screen.getByRole("button", { name: /continue/i }))
    fireEvent.click(screen.getByRole("button", { name: /use my own connectivity instead/i }))
    expect(screen.getByRole("list", { name: /before you sign in/i })).toBeVisible()
  })

  it("a handshake leads to Graduate, which can go back to Connect for another device", () => {
    mockApi()
    page({ ...claimed, vpnStatus: "running", peerCount: 1, lastHandshakeAt: "2026-10-14T10:00:00Z" })
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    fireEvent.click(screen.getByRole("button", { name: /connect another device/i }))
    expect(screen.getByRole("heading", { name: /connect your first device/i })).toBeVisible()
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }))
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toBeVisible()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/client && npx vitest run src/pages/onboarding/OnboardingPage.test.tsx
```
Expected: FAIL, because `@/pages/onboarding/OnboardingPage` does not exist.

- [ ] **Step 3: Implement**

Create `ui/packages/client/src/pages/onboarding/OnboardingPage.tsx`:

```tsx
import { useState, type ReactNode } from "react"
import type { OnboardingStatus } from "@librepod/shared"
import { Separator } from "@/components/ui/separator"
import { AccountStep, ClaimStep, ResumeScreen, WelcomeStep } from "./AccessSteps"
import { ConnectStep, GraduateStep, TrustStep, VpnStep, type ConnectivityPath } from "./ConnectivitySteps"

/**
 * The first-run wizard: raw-IP arrivals while the device is open or claimed. One
 * hero — the owner — and it ends with their first sign-in at the domain. The step
 * comes from the live status on every render (cluster truth), so reloads and pod
 * restarts resume for free. Page memory holds only the connectivity path ("bring
 * my own" — a reload asks again) and a revisit of Connect from Graduate.
 */
const STEPS = ["Welcome", "Claim", "Account", "Reach", "Trust", "Connect", "Graduate"] as const
export const WELCOME = 0
export const CLAIM = 1
export const ACCOUNT = 2
export const VPN = 3
export const TRUST = 4
export const CONNECT = 5
export const GRADUATE = 6

const WELCOME_KEY = "librepod-onboarding-welcome"

export function deriveStep(s: OnboardingStatus): number {
  if (s.state !== "claimed") return CLAIM
  if (!s.account) return ACCOUNT
  // An unknown VPN status counts as not installed: a repeat install is harmless
  // (409 counts as success). Once it is installing, running or failing, Trust comes
  // first — never skip the CA.
  if (s.vpnStatus === "not_installed" || s.vpnStatus == null) return VPN
  if (!s.peerCount) return TRUST
  if (!s.lastHandshakeAt) return CONNECT
  return GRADUATE
}

export function OnboardingPage({ status, onRefresh }: { status: OnboardingStatus; onRefresh: () => void }) {
  // Hooks first — the early return below must never skip them.
  const [userStep, setUserStep] = useState<number | null>(null)
  const [path, setPath] = useState<ConnectivityPath>("wireguard")
  const [revisit, setRevisit] = useState<number | null>(null)

  if (status.state === "claimed" && !status.session) {
    return <Frame><ResumeScreen onResumed={onRefresh} /></Frame>
  }

  const derived = deriveStep(status)
  const seenWelcome = localStorage.getItem(WELCOME_KEY) === "1"
  const floor = derived === CLAIM && !seenWelcome ? WELCOME : derived
  const step = revisit ?? Math.max(floor, userStep ?? 0)
  const go = (next: number) => {
    setRevisit(null)
    setUserStep(next)
  }

  return (
    <Frame>
      <StepRail current={step} />
      <Separator className="my-6" />
      {step === WELCOME && <WelcomeStep onBegin={() => { localStorage.setItem(WELCOME_KEY, "1"); go(CLAIM) }} />}
      {step === CLAIM && <ClaimStep onClaimed={onRefresh} />}
      {step === ACCOUNT && (
        <AccountStep baseDomain={status.baseDomain} previousAccount={status.previousAccount}
          onDone={() => { onRefresh(); go(VPN) }} onSessionLost={onRefresh} />
      )}
      {step === VPN && (
        <VpnStep status={status}
          onWireguard={() => { setPath("wireguard"); onRefresh(); go(TRUST) }}
          onOwn={() => { setPath("own"); go(TRUST) }}
          onSessionLost={onRefresh} />
      )}
      {step === TRUST && <TrustStep onDone={() => go(path === "own" ? GRADUATE : CONNECT)} />}
      {step === CONNECT && (
        <ConnectStep status={status} onConnected={() => go(GRADUATE)}
          onUseOwn={() => { setPath("own"); go(GRADUATE) }} onSessionLost={onRefresh} />
      )}
      {step === GRADUATE && <GraduateStep status={status} path={path} onAnotherDevice={() => setRevisit(CONNECT)} />}
      {step > WELCOME && step < GRADUATE && (
        <button className="mt-6 text-xs text-muted-foreground hover:text-foreground" onClick={() => go(step - 1)}>
          Back
        </button>
      )}
    </Frame>
  )
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-lg">{children}</div>
    </div>
  )
}

function StepRail({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="setup progress">
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
```

- [ ] **Step 4: Run to verify it passes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/client && npx vitest run src/pages/onboarding
```
Expected: PASS. `OnboardingPage.test.tsx` has 17 tests (9 derivation + 8 page), and the Task 14/15 suites still pass.

- [ ] **Step 5: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/client/src/pages/onboarding/OnboardingPage.tsx ui/packages/client/src/pages/onboarding/OnboardingPage.test.tsx
git commit -m "feat(ui): wizard page — steps from cluster truth, WireGuard and bring-your-own paths"
git log --oneline -1
```

---
### Task 17: RootGate, pre-auth screens and the router

**Files:**
- Create: `ui/packages/client/src/hooks/useBootstrapStatus.ts`
- Create: `ui/packages/client/src/components/PreAuthScreens.tsx`, `ui/packages/client/src/components/RootGate.tsx` (#215's ideas, written for the new states)
- Modify: `ui/packages/client/src/router.tsx`
- Test: `ui/packages/client/src/components/PreAuthScreens.test.tsx`, `ui/packages/client/src/components/RootGate.test.tsx`

**Interfaces:**
- Consumes: `GET /api/bootstrap/status` (Task 11); `OnboardingPage` (Task 16); `AuthGate`, `AppShell`, `FullScreenSpinner` (existing).
- Produces:
  - `useBootstrapStatus()`: TanStack query `["bootstrapStatus"]` that polls every 4 s until `state === "finished"`.
  - `WakingScreen()`, `NotSetUpScreen()`, `UseDomainScreen({ status })`.
  - `RootGate()`: the router's root element. AuthGate and AppShell sit under its `<Outlet />`.

- [ ] **Step 1: Write the failing tests**

Create `ui/packages/client/src/components/PreAuthScreens.test.tsx`:

```tsx
import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { OnboardingStatus } from "@librepod/shared"
import { NotSetUpScreen, UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"

const finished: OnboardingStatus = {
  state: "finished", arrival: "ip", baseDomain: "libre.pod", session: false, account: null, previousAccount: null,
  vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
}

describe("PreAuthScreens", () => {
  it("WakingScreen says the device is starting and the page updates itself", () => {
    render(<WakingScreen />)
    expect(screen.getByRole("heading", { name: /waking up/i })).toBeVisible()
    expect(screen.getByText(/updates itself/i)).toBeVisible()
  })

  it("NotSetUpScreen sends the visitor to the device's IP address", () => {
    render(<NotSetUpScreen />)
    expect(screen.getByRole("heading", { name: /isn't set up yet/i })).toBeVisible()
    expect(screen.getByText(/ip address/i)).toBeVisible()
  })

  it("UseDomainScreen leads with the domain, links the root CA, and offers no wizard", () => {
    render(<UseDomainScreen status={finished} />)
    expect(screen.getByRole("heading", { name: "libre.pod" })).toBeVisible()
    expect(screen.getByRole("link", { name: /open libre\.pod/i })).toHaveAttribute("href", "https://libre.pod")
    expect(screen.getByRole("link", { name: /download root ca/i })).toHaveAttribute("href", "/api/bootstrap/ca")
    expect(screen.queryByRole("link", { name: /connection keys/i })).toBeNull()
  })
})
```

Create `ui/packages/client/src/components/RootGate.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router-dom"
import type { OnboardingStatus } from "@librepod/shared"
import { RootGate } from "@/components/RootGate"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"

vi.mock("@/hooks/useBootstrapStatus", () => ({ useBootstrapStatus: vi.fn() }))

const base: OnboardingStatus = {
  state: "waiting", arrival: "ip", baseDomain: "libre.pod", session: false, account: null, previousAccount: null,
  vpnStatus: null, peerCount: null, lastHandshakeAt: null, endpointSuggestion: null,
}

function gateWith(status: OnboardingStatus | undefined, isPending = false) {
  vi.mocked(useBootstrapStatus).mockReturnValue({ data: status, isPending, refetch: vi.fn() } as unknown as ReturnType<
    typeof useBootstrapStatus
  >)
  return render(
    <MemoryRouter initialEntries={["/catalog"]}>
      <Routes>
        <Route element={<RootGate />}>
          <Route path="*" element={<p>APP-MARKER</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe("RootGate — state × arrival", () => {
  beforeEach(() => localStorage.clear())

  it("pending: a spinner, never the app", () => {
    gateWith(undefined, true)
    expect(screen.queryByText("APP-MARKER")).toBeNull()
  })

  // The regression the whole flow exists for: no answer or a converging cluster
  // shows WakingScreen — never the app or an SSO bounce.
  it.each([
    ["no answer from the server", undefined],
    ["waiting, raw IP", { ...base, state: "waiting" as const }],
    ["waiting, domain", { ...base, state: "waiting" as const, arrival: "domain" as const }],
  ])("%s → WakingScreen", (_name, status) => {
    gateWith(status)
    expect(screen.getByRole("heading", { name: /waking up/i })).toBeVisible()
    expect(screen.queryByText("APP-MARKER")).toBeNull()
  })

  it("open, raw IP → the wizard, at any path", () => {
    gateWith({ ...base, state: "open" })
    expect(screen.getByText(/welcome to your librepod/i)).toBeVisible()
  })

  it("open, domain → not set up yet", () => {
    gateWith({ ...base, state: "open", arrival: "domain" })
    expect(screen.getByRole("heading", { name: /isn't set up yet/i })).toBeVisible()
  })

  it("claimed, raw IP, no setup session → Resume", () => {
    gateWith({ ...base, state: "claimed" })
    expect(screen.getByRole("heading", { name: /continue setting up/i })).toBeVisible()
  })

  it("claimed, raw IP, setup session → the wizard continues", () => {
    gateWith({ ...base, state: "claimed", session: true })
    expect(screen.getByRole("heading", { name: /create your account/i })).toBeVisible()
  })

  it("claimed, domain → the app (its SSO sign-in finishes onboarding)", () => {
    gateWith({ ...base, state: "claimed", arrival: "domain" })
    expect(screen.getByText("APP-MARKER")).toBeVisible()
  })

  it("finished, domain → the app", () => {
    gateWith({ ...base, state: "finished", arrival: "domain" })
    expect(screen.getByText("APP-MARKER")).toBeVisible()
  })

  it("finished, raw IP → UseDomainScreen, no wizard", () => {
    gateWith({ ...base, state: "finished" })
    expect(screen.getByRole("heading", { name: "libre.pod" })).toBeVisible()
    expect(screen.queryByText(/welcome to your librepod/i)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/client && npx vitest run src/components/PreAuthScreens.test.tsx src/components/RootGate.test.tsx
```
Expected: FAIL, because the modules do not exist.

- [ ] **Step 3: Implement the status hook**

Create `ui/packages/client/src/hooks/useBootstrapStatus.ts`:

```ts
import { useQuery } from "@tanstack/react-query"
import type { OnboardingStatus } from "@librepod/shared"

/**
 * The pre-auth heartbeat. Plain fetch on purpose — apiFetch's 401 handler
 * redirects to /api/auth/login, which on a fresh device is a redirect into an
 * unresolvable host. That redirect is the exact bug onboarding fixes.
 */
export function useBootstrapStatus() {
  return useQuery<OnboardingStatus>({
    queryKey: ["bootstrapStatus"],
    queryFn: async () => {
      const res = await fetch("/api/bootstrap/status")
      if (!res.ok) throw new Error(`bootstrap status ${res.status}`)
      return res.json()
    },
    // The wizard follows live state (claim, install, peers, the first sign-in) until
    // onboarding finishes. Finished is final — the domain app, or the static
    // UseDomainScreen — so polling stops there.
    refetchInterval: (query) => (query.state.data?.state === "finished" ? false : 4000),
  })
}
```

- [ ] **Step 4: Implement the pre-auth screens**

Create `ui/packages/client/src/components/PreAuthScreens.tsx`:

```tsx
import type { ReactNode } from "react"
import type { OnboardingStatus } from "@librepod/shared"
import { Button } from "@/components/ui/button"

/** OpenBao or Casdoor isn't answering yet (fresh boot, or a restart). */
export function WakingScreen() {
  return (
    <Centered>
      <h1 className="text-2xl font-semibold">Your LibrePod is waking up</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        System services are starting. This usually takes a few minutes — this page updates itself.
      </p>
    </Centered>
  )
}

/** A domain arrival before anyone claimed the device: setup runs on the raw IP. */
export function NotSetUpScreen() {
  return (
    <Centered>
      <h1 className="text-2xl font-semibold">This LibrePod isn't set up yet</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Setup runs on the device's own address. Open <span className="font-mono">http://</span> followed by
        this device's IP address to start — you will need its setup code.
      </p>
    </Centered>
  )
}

/** Onboarding finished but the browser came over the raw IP: the app lives on the domain now. */
export function UseDomainScreen({ status }: { status: OnboardingStatus }) {
  return (
    <Centered>
      <p className="text-sm text-muted-foreground">Your device is set up and has a name:</p>
      <h1 className="mt-2 font-mono text-2xl font-semibold break-all">{status.baseDomain}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Open it from a device on your VPN (or with your own DNS for it). This raw address no longer runs setup.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button render={<a href={`https://${status.baseDomain}`} />}>Open {status.baseDomain}</Button>
        <Button variant="ghost" render={<a href="/api/bootstrap/ca" download />}>Download root CA</Button>
      </div>
    </Centered>
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

- [ ] **Step 5: Implement RootGate**

Create `ui/packages/client/src/components/RootGate.tsx`:

```tsx
import { Outlet } from "react-router-dom"
import { useBootstrapStatus } from "@/hooks/useBootstrapStatus"
import { FullScreenSpinner } from "@/components/FullScreenSpinner"
import { NotSetUpScreen, UseDomainScreen, WakingScreen } from "@/components/PreAuthScreens"
import { OnboardingPage } from "@/pages/onboarding/OnboardingPage"

/**
 * Sits ABOVE AuthGate. One status decides the whole pre-auth experience:
 *   waiting, or no answer     → WakingScreen
 *   finished                  → domain: the app (Outlet) · raw IP: UseDomainScreen
 *   open + domain             → NotSetUpScreen (setup runs on the raw IP)
 *   claimed + domain          → the app: AuthGate's SSO sign-in finishes onboarding
 *   open or claimed + raw IP  → the wizard, at any path
 */
export function RootGate() {
  const { data, isPending, refetch } = useBootstrapStatus()
  if (isPending) return <FullScreenSpinner />
  if (!data || data.state === "waiting") return <WakingScreen />
  if (data.state === "finished") return data.arrival === "ip" ? <UseDomainScreen status={data} /> : <Outlet />
  if (data.arrival === "domain") return data.state === "open" ? <NotSetUpScreen /> : <Outlet />
  return <OnboardingPage status={data} onRefresh={() => void refetch()} />
}
```

- [ ] **Step 6: Route everything through RootGate**

Replace the contents of `ui/packages/client/src/router.tsx` with:

```tsx
import { createBrowserRouter, Navigate } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { AuthGate } from "./components/AuthGate"
import { RootGate } from "./components/RootGate"
import { CatalogPage } from "./pages/CatalogPage"
import { AppDetailPage } from "./pages/AppDetailPage"
import { MyAppsPage } from "./pages/MyAppsPage"
import { NotFoundPage } from "./pages/NotFoundPage"

export const router = createBrowserRouter([
  {
    // First-run onboarding decides before any SSO redirect can fire (RootGate).
    element: <RootGate />,
    children: [
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

- [ ] **Step 7: Run all client tests and the client build**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm run test:client && npm run build:client
```
Expected:
- All client suites pass, including `PreAuthScreens` (3) and `RootGate` (11).
- The Vite build succeeds.

- [ ] **Step 8: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/client/src/hooks/useBootstrapStatus.ts ui/packages/client/src/components/PreAuthScreens.tsx ui/packages/client/src/components/PreAuthScreens.test.tsx ui/packages/client/src/components/RootGate.tsx ui/packages/client/src/components/RootGate.test.tsx ui/packages/client/src/router.tsx
git commit -m "feat(ui): RootGate — onboarding state and arrival decide the screen before any SSO redirect"
git log --oneline -1
```

---
### Task 18: Tier 1 — the "never an SSO redirect" invariant

**Files:**
- Modify: `ui/packages/e2e/projects/tier1.config.ts`
- Create: `ui/packages/e2e/tests/app-level/onboarding.spec.ts`

**Interfaces:**
- Consumes:
  - The `BOOTSTRAP_MODE_OVERRIDE` seam (Task 11): status answers `finished` and the store creates nothing (Task 5).
  - RootGate's `finished` + domain → app (Task 17).
- Produces: Tier 1 runs with `BOOTSTRAP_MODE_OVERRIDE: "finished"`. One browser test pins that the authenticated app renders with no `/api/auth` redirect.

- [ ] **Step 1: Force the finished state in the Tier 1 server**

In `ui/packages/e2e/projects/tier1.config.ts`, in `webServer.env`, insert directly after `CASDOOR_APP_NAME: "marketplace-ui",`:

```ts
      // RootGate owns the first paint. Tier 1 has no Casdoor and its dev-mode
      // OpenBao has no system/ mount, so the onboarding status would say
      // "waiting" and hold EVERY spec on the WakingScreen. Force the finished
      // state (the documented test seam in bootstrap.controller.ts; the
      // onboarding store then creates nothing). A domain arrival in "finished"
      // is a RootGate pass-through. The state × arrival matrix is pinned by
      // RootGate.test.tsx instead.
      BOOTSTRAP_MODE_OVERRIDE: "finished",
```

- [ ] **Step 2: Add the invariant test**

Create `ui/packages/e2e/tests/app-level/onboarding.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

// The regression this file exists for: on a fresh device the UI used to bounce
// straight to /api/auth/login → an unresolvable IdP host. RootGate must decide
// before any SSO redirect can fire.
//
// NB: the shared Tier 1 server runs with BOOTSTRAP_MODE_OVERRIDE=finished (see
// tier1.config.ts) so the rest of the suite sees the authenticated app. The
// wizard, Resume and WakingScreen first paints are pinned at unit level
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
```

- [ ] **Step 3: Run Tier 1 for this spec and one existing spec**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm run test:e2e:ui -- tests/app-level/onboarding.spec.ts tests/app-level/smoke.spec.ts
```
Expected: both specs pass.

Tier 1 needs Docker (compose) and a Chromium that launches. On NixOS, Playwright's bundled Chromium needs the patchelf workaround described in the auto-memory note "Playwright Chromium on NixOS". If the environment can't run Tier 1, do not mark it passed. Record "Tier 1 not run locally: <reason>" in the task report; CI runs it on the PR.

- [ ] **Step 4: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add ui/packages/e2e/projects/tier1.config.ts ui/packages/e2e/tests/app-level/onboarding.spec.ts
git commit -m "test(ui): Tier 1 pins that the app renders without an SSO redirect under the finished onboarding state"
git log --oneline -1
```

---

### Task 19: Docs and the full gate

**Files:**
- Modify (carry, then edit): `README.md`, `ui/CLAUDE.md`
- Create (carry, then rewrite): `ui/PRODUCT.md`

**Interfaces:**
- Consumes: everything above; the commands and paths from Global Constraints.
- Produces: README first-run section and wg-easy row; the `ui/CLAUDE.md` API, install-flow and env sections; `ui/PRODUCT.md` onboarding copy. Public docs contain no hostnames.

- [ ] **Step 1: Carry #215's doc changes**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git diff db77265 b42337c -- README.md ui/CLAUDE.md ui/PRODUCT.md | git apply --3way
```

This brings the README wg-easy row ("Catalog app …"), the `ui/CLAUDE.md` DEVICE_IP install-flow step, the `NODE_NAME` env row, a `/api/bootstrap/*` request-flow bullet (rewritten below) and #215's `ui/PRODUCT.md` (rewritten below).

- [ ] **Step 2: README — first-run section**

In `README.md`, insert before the `## 🌐 Remote Access` heading (after the `---` that ends the bootstrap section):

````markdown
## 🔑 First Run: Claim Your Device

A fresh LibrePod is set up from a browser, on the device's own address. Once the
system apps are up, open `http://<device-ip>`.

1. **Get the setup code.** Only someone with access to the cluster can read it —
   that is what makes you the owner:

   ```bash
   kubectl -n marketplace-ui logs deploy/marketplace-ui | grep "setup code"
   ```

2. **Claim the device** with the code and an admin password (at least 12
   characters, no spaces). `admin` is the device's master account: its password
   is also the default admin password of apps that ship one (e.g. wg-easy), and
   it is kept in OpenBao at `system/admin`.
3. **Create your account** — the one you sign in with every day
   (`<name>@<your-domain>`).
4. **Choose how your devices reach it by name:** set up WireGuard (the wizard
   installs it and gives you a QR code), or bring your own (Tailscale/Headscale,
   a tunnel, or your own DNS for `<your-domain>` and `*.<your-domain>`).
5. **Trust the root certificate** the wizard offers, then open
   `https://<your-domain>` and sign in with your account. That first sign-in
   finishes setup; from then on the raw IP address only points to the domain.

**Cloud servers and shared networks.** The wizard runs over plain http. On a
server with a public IP, use `https://<device-ip>` instead (one certificate
warning — the root CA isn't trusted yet), or an SSH tunnel:
`ssh -L 8080:<device-private-ip>:80 you@<device-public-ip>`, then open
`http://127.0.0.1:8080`.

**Lost a password or a VPN key, or abandoned setup?** Reopen onboarding with a
new setup code. Apps, data, users and VPN peers stay:

```bash
kubectl -n marketplace-ui exec deploy/marketplace-ui -- reset-onboarding
```

---

````

- [ ] **Step 3: `ui/CLAUDE.md` — the onboarding API**

Replace the carried request-flow bullet

```markdown
- `/api/bootstrap/*` (first-run onboarding) is exempt from `AuthGuard`. `POST /api/bootstrap/install`
  is a second, session-less entry into `InstalledService.install()`: onboarding-cookie gated
  (`OnboardingGuard`), claimed devices only, allowlist `['wg-easy']`, settings only (no custom variables).
```

with

```markdown
- `/api/bootstrap/*` (first-run onboarding, `src/onboarding/`) is exempt from `AuthGuard` — see
  "First-run onboarding" below. `POST /api/bootstrap/install` is a second, session-less entry into
  `InstalledService.install()`: `OnboardingGuard`-gated, allowlist `{'wg-easy': INIT_PASSWORD}`, settings
  only (no custom variables); the server fills the admin-password setting from OpenBao `system/admin`.
```

Then add this subsection directly before `### Catalog (`CatalogService`)`:

```markdown
### First-run onboarding (`src/onboarding/`)

One OpenBao record, `system/marketplace-ui/onboarding` (`OnboardingStore`): `open` (a setup code
exists) → `claimed` (admin password set with the code) → `finished` (first SSO sign-in since the
claim). `waiting` is computed: OpenBao unreachable, or Casdoor unreachable before `finished`. The
store creates the record on start (KV check-and-set, `cas: 0`) and logs `LibrePod setup code: …`
while open/claimed; reads are cached ≤5 s so `reset-onboarding` (another process) lands without a
restart. The admin password lives readable in `system/admin`.
- `GET /status` — public, read-only, never sets a cookie. A valid SSO session short-circuits to
  `finished` (and retries the finish write). Telemetry (account, VPN status, peers, endpoint
  suggestion) only with a valid onboarding cookie.
- `POST /claim {code,password}` and `/resume {code}` set `mp_onboarding`: HMAC via `SessionService`,
  `sub: 'onboarding'` + the record's `generation`, httpOnly, NOT Secure. `OnboardingGuard` admits it
  only while `claimed` with a matching generation; `AuthGuard` never admits it.
- `POST /account`, `POST /install`, `/wireguard/*` (wg-easy proxy) — `OnboardingGuard`-gated.
- The SSO callback calls `OnboardingStore.finishIfClaimed()`; a failure never blocks the sign-in.
- `reset-onboarding` (`/usr/local/bin` in the image) runs `dist/onboarding/reset-onboarding.cli.js`:
  new code, `open`, generation + 1, account kept.
- `BOOTSTRAP_MODE_OVERRIDE` forces the state (Tier 1: `finished`) and skips record creation.
```

Then add these rows to the env table, directly after the carried `NODE_NAME` row:

```markdown
| `CASDOOR_BASE_URL` | (empty) | in-cluster Casdoor (`http://casdoor.casdoor.svc.cluster.local`). Unset ⇒ onboarding status stays `waiting` |
| `CASDOOR_ADMIN_DEFAULT_PASSWORD` | `123` | Casdoor's factory admin password; the claim replaces it with the owner's admin password |
| `WGEASY_BASE_URL` | (empty) | in-cluster wg-easy for the wizard's peer endpoints |
| `ROOT_CA_PATH` | (empty) | the mounted root CA served by `GET /api/bootstrap/ca` |
| `OPENBAO_SYSTEM_MOUNT` | `system` | KV v2 mount holding the onboarding record and `admin` |
| `BOOTSTRAP_MODE_OVERRIDE` | (empty) | **test seam only** (Tier 1): forces the onboarding state and skips record creation |
```

- [ ] **Step 4: `ui/PRODUCT.md` — onboarding copy for the new design**

Replace the whole of `ui/PRODUCT.md` with:

```markdown
# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a non-sysadmin self-hosting owner ("I want to self-host apps, but I don't want
to be a system administrator"). First meets the product right after a fresh install,
reaching the UI over a raw IP — `http://192.168.x.y` on a home LAN, or a public IP on a
cloud server — possibly on a phone. Not assumed to know Kubernetes, Flux, certificates or
WireGuard; setup starts with a code read from the device's log, so someone with access to
the machine is involved once.

## Product Purpose

LibrePod marketplace UI: browse a catalog of pre-configured apps and install/uninstall
them one-click on the user's own cluster via GitOps. Success for first-run: the owner goes
from `http://<ip>` to a claimed device, a personal account, a trusted root CA, working
connectivity (WireGuard or their own), and the first SSO sign-in at `https://<base-domain>`.

## Positioning

Zero-config self-hosting: SSO, a private CA and an optional WireGuard VPN that carries DNS
arrive working out of the box; the device is claimed in a browser wizard with a setup code —
no Docker knowledge, no env vars, no manual volume mounts.

## Operating Context

- Fresh boot: system apps converge over several minutes; the UI tolerates partial
  availability ("waking up" while OpenBao or Casdoor isn't answering).
- Before onboarding finishes: the raw IP serves the wizard; `*.<base-domain>` does not
  resolve for the user's devices.
- One flow for every environment — a home device, a cloud VM with a public IP, a VM on a
  shared corporate network, any Kubernetes cluster. The setup code is the only gate.
- WireGuard is the default DNS unlock (its client configs hand out the device as DNS);
  "I'll bring my own" covers Tailscale/Headscale, tunnels and own DNS.
- After onboarding: access is `https://<name>.<baseDomain>`; the raw IP only points to the
  domain.
- The pod's network ≠ the browser's network: the server reaches Casdoor, wg-easy and the
  root CA in-cluster while the browser cannot resolve them yet.

## Capabilities and Constraints

- Auth: OIDC via Casdoor + stateless HMAC session cookie (Secure) — cannot work over
  plain-HTTP raw IP by design; the wizard never attempts SSO over IP, and the AuthGate
  redirect chain must never fire for an un-onboarded or IP-bound visitor.
- Proof of ownership: a 12-character setup code marketplace-ui creates on first start and
  prints to its log. Claiming needs it, resuming in another browser needs it, and it dies
  when onboarding finishes; `reset-onboarding` issues a new one.
- Identities: `admin` (Casdoor's built-in admin) is the master account — its password is
  set at the claim, stored readable in OpenBao `system/admin`, and is the default admin
  password of apps that ship one (wg-easy). The owner then creates a personal account
  (`<name>@<base-domain>`) for daily SSO.
- The first SSO sign-in at the domain finishes onboarding. Until then the wizard is the
  only way in; there is no "set up later".
- State is durable: one OpenBao record. Live service state (peers, handshakes) only drives
  the screens, never access.
- Only marketplace-ui serves on the raw device IP; other apps' UIs are unreachable
  mid-wizard, so the wizard cannot hand off to them.

## Brand Commitments

Name: LibrePod. Dark mode is forced. shadcn-style component system on Tailwind v4
tokens, Geist Variable, monochrome neutral scale.

## Product Principles

1. Proxy, don't redirect: when the browser can't reach a service, the server does it on
   its behalf over cluster-internal DNS.
2. Cluster truth is the wizard's state: derive steps from the onboarding record and live
   services, never from wizard-local storage.
3. First-run has exactly one hero — the owner — and it ends with their first sign-in.
4. The raw IP is scaffolding: every step exists to graduate the user onto named, trusted
   access.
5. Fail visible, not fatal: partial convergence presents as "waking up," never as a dead
   SSO redirect.

## Evidence on Hand

- Implementation: `ui/packages/{client,server,shared}` (NestJS 11, React 19, Tailwind
  v4/shadcn); onboarding in `packages/server/src/onboarding/` and
  `packages/client/src/pages/onboarding/`; design in
  `docs/superpowers/specs/2026-10-14-onboarding-setup-code-design.md`.
- Root CA mounted in the marketplace-ui pod
  (`apps/marketplace-ui/overlays/librepod/deployment-auth-patch.yaml`).
```

- [ ] **Step 5: Hostname check on public docs**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code && grep -nE 'librepod-(dev|beelink)' README.md ui/PRODUCT.md ui/CLAUDE.md; echo "matches: $?"
```
Expected: `matches: 1` (grep found nothing).

- [ ] **Step 6: Full gate**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui && npm test && npm run test:e2e && npm run test:client && npm run build && npm run build:client
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code/ui/packages/server && npx tsc --noEmit -p tsconfig.json && rm -f .tsbuildinfo
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code && for app in marketplace-ui wg-easy openbao; do kustomize build apps/$app/overlays/librepod | kubeconform -strict -summary -ignore-missing-schemas -schema-location default; done
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code && git status --short
```
Expected:
- Every suite passes and both builds succeed.
- tsc exits 0.
- All three kubeconform runs report `Invalid: 0, Errors: 0`.
- `git status` shows only the three doc files staged or modified, plus the user's untracked files if any; never stray build output.

- [ ] **Step 7: Commit**

```bash
cd /home/alex/.herdr/worktrees/marketplace/feat-onboarding-setup-code
git add README.md ui/CLAUDE.md ui/PRODUCT.md
git commit -m "docs: first run with a setup code — README, ui/CLAUDE.md onboarding API, ui/PRODUCT.md"
git log --oneline -1
```

---

## After the last task (not part of execution — needs the user's go-ahead)

- Push `feat/onboarding-setup-code` and open the PR (title and body free of hostnames).
- Close PR #215 with a pointer to the new PR.
- Live dev check (spec §13). Each step is confirmed with the user first:
  1. Confirm Casdoor's built-in admin is still `123`.
  2. Wipe wg-easy's old NFS data folder.
  3. Remove #215-era leftovers (e.g. a `marketplace-ui-admin-credential` Secret).
  4. Publish the artifacts and walk the wizard on the raw IP.
