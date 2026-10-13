# Migrate all apps to OpenBao settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every marketplace app off the legacy Gogs-stored `params` / `secrets[].generate` / `templates.secret` mechanism onto the `settings` + OpenBao + ExternalSecret pattern, with zero secret-value changes for apps whose data survives on NFS.

**Architecture:** marketplace-ui gains (a) `generate` support on settings items with read-merge-write against the OpenBao entry, (b) a "legacy mirror" that copies existing Gogs-committed secret values into OpenBao (boot + hourly + synchronously at uninstall). Apps then migrate one by one: metadata.yaml converts to `settings`, the app base swaps `secret.yaml` for an `ExternalSecret`, and workloads read the synced Secret via `envFrom` (Kustomize) or `valuesFrom` (Helm). Because CI republishes the same version tag on manifest change, each app's migration auto-flows to every device that has it installed — the OpenBao entry must already exist by then, which is what the mirror guarantees.

**Tech Stack:** Kubernetes + FluxCD (OCI artifacts, postBuild substitution), OpenBao KV v2, External Secrets Operator, NestJS (marketplace-ui server), React (install dialog), Kustomize, vitest, Playwright (Tier 1/2 e2e).

**Spec:** `docs/superpowers/specs/2026-10-04-app-install-settings-design.md` (in the main checkout `~/code/librepod/marketplace` — `docs/superpowers/` is gitignored; force-add spec+plan when the PRs reference them).

**Execution location:** the `feat/migrate-apps-to-openbao` worktree (`/home/alex/.herdr/worktrees/marketplace/feat-migrate-apps-to-openbao`). The spec/plan live in the main checkout — read them from there.

## Global Constraints

- **Data safety is absolute.** No task may change, regenerate, or drop a secret value that surviving NFS data depends on. Preservation comes from three mechanisms: the legacy mirror (in-place migration), the uninstall bridge (uninstall→reinstall), and read-merge at install (generated items reuse the stored value). Never "regenerate and hope".
- **Ordering:** marketplace-ui **0.8.0** must be released (image built, `infrastructure/system-apps/marketplace-ui.yaml` `ref.tag` bumped, deployed on dev) **before any app-metadata migration merges**. The catalog reaches every cluster ~5 min after merge; an old marketplace-ui installing an app whose settings contain `generate` would write no value and break the install.
- **Never bump `spec.version` for migration-only changes.** `spec.version` is the upstream app version. Manifest changes republish the *same* OCI tag (new digest) via `publish-apps.yaml`, and installed apps' `OCIRepository` pins follow the tag — that is the delivery vehicle for in-place migration.
- **OpenBao KV mount is `apps`** (NOT the client default `secret`). The entry for app `<name>` is key `apps/<name>` inside mount `apps` → HTTP path `/v1/apps/data/apps/<name>`. The `ClusterSecretStore openbao` (`infrastructure/system-configs/openbao-clustersecretstore.yaml`) already points there.
- **After every app-manifest change merges**, verify the `publish-apps` workflow actually ran and published (it diffs `HEAD~1` only — multi-commit pushes are a blind spot). Force with `gh workflow run publish-apps.yaml` if missed.
- **No device/cluster hostnames in commits, PRs, or docs** — use `dev`/`prod`. (Internal docs may keep `librepod-dev`.)
- **Generated settings items are hidden from the install dialog** and auto-resolve: answer → stored OpenBao value → default → fresh random (stored beats default: a catalog-added default must never clobber a value that living NFS data depends on). Resolution order for *question* items is unchanged from the spec: answer → default → omitted (stored values are NOT read back for questions).
- **Install writes the whole entry** (replace semantics, per spec §5.3): resolved questions + custom variables + resolved generated items. Stale keys not claimed by any item are dropped. The only look-back into the stored entry is generated-item preservation.
- **Values never pass through Flux `${VAR}` substitution.** They travel OpenBao → ESO → Secret → `envFrom`/`valuesFrom` only.
- **Each app migration is one PR-sized task**; apps in the same wave are independent but must not be bundled into one commit.
- **e2e fixtures** (`ui/packages/e2e/fixtures/catalog.fixture.yaml`) must be updated in the same task as any app that appears in them (currently: `vaultwarden`, `litellm`, `renovate`).
- **Testing:** server unit tests for every resolver/client/mirror behavior change; `npm test` from `ui/` must pass before each ui commit. App tasks verify with `kustomize build` + dev-cluster deployment.

## State at plan start (verified 2026-10-06)

Done and released: OpenBao system app 2.7.1 (auto-unseal, KV `apps/`, Kubernetes auth, bootstrap Job creating roles `external-secrets` + `marketplace-ui`), ESO system app 2.11.0, `ClusterSecretStore openbao`, marketplace-ui **0.7.0** with the settings feature (installer, dialog, OpenBao client, catalog passthrough, Tier 1 dev-mode OpenBao e2e).

Gaps this plan closes:

1. marketplace-ui manifests set **no `OPENBAO_*` env** — settings installs currently 503 in-cluster (feature shipped inert).
2. No `generate` support in the settings contract → the 8 generated-secrets apps cannot migrate.
3. `writeAppSettings` is a blind replace; marketplace-ui policy has no `read` → generated values cannot be preserved across reinstall.
4. Nothing copies existing Gogs-committed secret values into OpenBao → in-place artifact migration would leave ExternalSecrets with no entry (pods wait in `CreateContainerConfigError`).
5. Zero apps migrated (not even the spec's pilots).

The 11 legacy apps and their secrets:

| App | Secrets | Class | Data risk on value change |
|---|---|---|---|
| renovate | RENOVATE_TOKEN (req), RENOVATE_GITHUB_COM_TOKEN (opt) | user-supplied | none (cache PVC only) |
| open-webui | — (dead `OLLAMA_ENABLED` param) | pilot, Helm | none |
| xray-checker | SUBSCRIPTION_URL (req) | user-supplied | none |
| frpc | FRP_AUTH_TOKEN (req) | user-supplied | none (stateless) |
| vaultwarden | ADMIN_TOKEN (gen 64) | generated | low (admin login only) |
| netronome | SESSION_SECRET (gen 64) | generated | low (sessions invalidated) |
| happy-server | HAPPY_SERVER_SECRET, HAPPY_SERVER_PASSWORD (gen) | generated, **suspected dead** | investigate |
| litellm | LITELLM_SALT_KEY (gen 64), DB_PASSWORD (gen 40) | generated + postgres | **high** (has converge-db-password) |
| immich | DB_PASSWORD (gen 40) | generated + postgres | **high** (has converge-db-password) |
| remnawave | APP_SECRET (gen 64), DB_PASSWORD (gen 40) | generated + postgres | **high** (has converge-db-password) |
| obsidian-livesync | COUCHDB_PASSWORD, COUCHDB_SECRET (gen 32) | generated + CouchDB | **high, NO converge** — preservation-critical |
| seafile | 5× gen (see Task 16) | generated + MariaDB | **high, NO converge** — preservation-critical |

Delivery quirks discovered (handled per-task): immich/litellm/remnawave/vaultwarden get secrets Flux-substituted **into `.env` ConfigMaps**; frpc bakes the token into `frp.toml`; seafile maps one `${MYSQL_ROOT_PASSWORD}` onto two env keys; obsidian-livesync substitutes into a ConfigMap'd shell script; happy-server's declared secrets appear in no manifest.

## The migration recipe (applies to every app task, both patterns)

Every per-app task below applies this recipe plus its app-specific deltas. The recipe is complete; deltas name exact files/keys.

### Recipe K — Kustomize-type apps

**metadata.yaml** — replace `params` + `secrets` blocks with a `settings` block; strip the secret plumbing from templates:

```yaml
spec:
  # … displayName, description, icon, category, website, version, source unchanged …
  settings:
    allowCustom: true          # only where the app genuinely benefits (see per-app delta)
    items:
      - name: SOME_TOKEN       # question item (user-supplied secret)
        label: "Access token"
        description: "…"
        sensitive: true
        required: true
      - name: DB_PASSWORD      # generated item (machine secret)
        generate:
          length: 40           # keep the legacy length verbatim
  dependencies:
    required: [ …unchanged… ]
  templates:
    source: |                  # unchanged
    release: |                 # REMOVE the substituteFrom block entirely; keep
                               # postBuild.substitute: BASE_DOMAIN (and any other
                               # platform var the app's manifests still use)
    kustomization: |           # resources: source.yaml, release.yaml — drop secret.yaml
```

Remove: whole `params:` block, whole `secrets:` block, `templates.secret`, `substituteFrom`, the `- secret.yaml` line in `templates.kustomization`.

**base/externalsecret.yaml** (new file; add to `base/kustomization.yaml` resources):

```yaml
# Pulls this app's install settings from OpenBao. Written by marketplace-ui at
# install time (answer → default → stored value → generated); synced here by ESO.
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: <app>-settings
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: openbao
  target:
    name: <app>-settings
  dataFrom:
    - extract:
        key: apps/<app>
```

**base/secret.yaml** — delete the file; remove it from `base/kustomization.yaml` resources.

**Workload (Deployment/CronJob)** — the settings Secret comes **last** in `envFrom` so custom variables override `.env` defaults (spec D5):

```yaml
envFrom:
  - configMapRef:
      name: <app>            # generated name gets its hash suffix rewritten by kustomize
  - secretRef:
      name: <app>-settings   # non-optional: pods wait (CreateContainerConfigError) until ESO syncs
```

Remove the old `secretRef: <app>-secret` / `secretKeyRef` entries that read the deleted Secret. Any `${VAR}` placeholder line that carried a secret value **must be deleted from the `.env` file** (the Secret supplies that env var now) — leaving it would resolve to a literal `${VAR}`.

### Recipe H — Helm-type apps (open-webui)

Same metadata.yaml changes as Recipe K. Then:

- `ExternalSecret` as above (in base, alongside the chart source resources).
- HelmRelease (wherever it lives for the app — base or overlay): add

```yaml
spec:
  valuesFrom:
    - kind: Secret
      name: <app>-settings
      valuesKey: SOME_SETTING      # key in the settings Secret
      targetPath: chart.values.path # exact path in the chart's values
```

  and **delete that path from inline `values`** — Flux merges inline values last, so an inline value would win and the setting would be inert. A question wired through `valuesFrom` must always have an answer (`required` or a `default`), so the key always exists and `optional: true` is never needed.

  **Boolean questions are safe through `valuesFrom`** (verified live, open-webui pilot): helm-controller v1.6.5 YAML-parses each valuesFrom value before merging, so the string `"false"` arrives at the chart as a real boolean. Wire booleans ONLY through `valuesFrom`, never through env-string paths.

### Verification recipe (every app task)

1. **Build clean:** `kustomize build apps/<app>/overlays/librepod` (add `--enable-helm` for Helm apps) — assert no `${…}` leftovers except `${BASE_DOMAIN…}` forms, and the ExternalSecret renders.
2. **Seed OpenBao on dev** (for direct manifest testing, bypassing marketplace-ui):

   ```bash
   KCFG=~/.kube/librepod-dev.config
   ROOT_TOKEN=$(kubectl --kubeconfig $KCFG -n openbao get secret openbao-credentials -o jsonpath='{.data.root-token}' | base64 -d)
   kubectl --kubeconfig $KCFG -n openbao exec openbao-0 -- \
     env BAO_TOKEN="$ROOT_TOKEN" bao kv put apps/<app> KEY1=value1 KEY2=value2
   ```

3. **Deploy to dev** (per librepod-app skill — sed, never envsubst):

   ```bash
   kustomize build apps/<app>/overlays/librepod \
     | sed -e "s/\${BASE_DOMAIN:=libre.pod}/librepod.dev/g" -e "s/\${BASE_DOMAIN}/librepod.dev/g" \
     | kubectl --kubeconfig ~/.kube/librepod-dev.config apply -f -
   ```

4. **Assert:** pods `Running`; the synced Secret exists (`kubectl -n <app> get secret <app>-settings`); the pod env carries the values (`kubectl -n <app> exec deploy/<app> -- env | grep KEY` — or check the CronJob's created Job); **ESO status** `ExternalSecret/<app>-settings` is `Ready=True`.
5. **Data-safety assertion (DB apps / any installed instance):** BEFORE applying, capture the live value (`kubectl -n flux-system get secret <app>-config -o jsonpath='{.data.DB_PASSWORD}' | base64 -d`); AFTER migration, assert the OpenBao entry holds the identical value (via `bao kv get` as above) and the app still authenticates to its DB (logs clean).
6. **UI path on dev (once Task 4 is deployed):** uninstall + reinstall the app from the marketplace UI with answers; assert the dialog, the OpenBao entry, and the running pod.
7. **Ask the user about cleanup** of dev test deployments when done.

### Merge checklist (every app task)

- [ ] `publish-apps` workflow ran and published both tags for the app (`gh run list --workflow=publish-apps.yaml`; force `gh workflow run publish-apps.yaml` if the change wasn't picked up).
- [ ] e2e fixture updated if the app appears in `ui/packages/e2e/fixtures/catalog.fixture.yaml`.
- [ ] Commit message references no device hostnames.

---

## Wave 0 — platform plumbing (merge immediately, independent of the ui release)

### Task 1: Wire marketplace-ui's OpenBao env + grant policy read + policy re-run trigger

**Files:**
- Modify: `apps/marketplace-ui/base/configmap.yaml`
- Modify: `apps/openbao/overlays/librepod/policies/marketplace-ui-write-apps.hcl`
- Modify: `apps/openbao/components/bootstrap/job.yaml`

**Interfaces:**
- Produces: marketplace-ui pods get `OPENBAO_ADDR`/`OPENBAO_KV_MOUNT` at runtime (no image rebuild needed — env is read from the ConfigMap by the running 0.7.0 image); the `marketplace-ui-write-apps` policy gains `read` on `apps/data/*` (consumed by Tasks 6–7's `readAppSettings` and Task 8's mirror); a `policies-version` pod-template annotation on the bootstrap Job that makes policy changes recreate the Job (release template already sets `force: true`).

- [ ] **Step 1: Add the OpenBao env to marketplace-ui's ConfigMap**

Append to `apps/marketplace-ui/base/configmap.yaml` `data:`:

```yaml
  # Settings store (install questions + generated secrets) — the OpenBao system
  # app. Unset OPENBAO_ADDR would make every settings install 503. The KV mount
  # is "apps" (NOT the client default "secret") — see the ClusterSecretStore.
  # OPENBAO_AUTH_MOUNT/ROLE defaults (kubernetes / marketplace-ui) match the
  # role the openbao bootstrap Job creates. Never set OPENBAO_TOKEN here — it
  # is a Tier-1 test seam only.
  OPENBAO_ADDR: "http://openbao.openbao.svc.cluster.local:8200"
  OPENBAO_KV_MOUNT: "apps"
```

Verify the Deployment actually consumes this ConfigMap via `envFrom` (`grep -n "marketplace-ui-env" apps/marketplace-ui/base/deployment.yaml`) — if it references it another way, wire accordingly.

- [ ] **Step 2: Grant read on `apps/data/*` to marketplace-ui**

In `apps/openbao/overlays/librepod/policies/marketplace-ui-write-apps.hcl`, change:

```hcl
path "apps/data/*" {
  capabilities = ["create", "update", "read"]
}
```

(Update the file's header comment: read is needed for install-time read-merge of generated values and for the legacy secret mirror.)

- [ ] **Step 3: Add a policy-version annotation to the bootstrap Job pod template**

The bootstrap Job's spec is immutable and the policies ConfigMap has `disableNameSuffixHash: true`, so a policy edit alone never re-runs the Job. Add to `apps/openbao/components/bootstrap/job.yaml` → `spec.template.metadata.annotations`:

```yaml
        # Bump whenever an overlay policy .hcl changes: the Job spec is
        # immutable, so this is what makes the apply recreate (force:true) and
        # re-run the bootstrap, which re-applies policies idempotently.
        openbao.librepod/policies-version: "2"
```

- [ ] **Step 4: Verify on dev**

```bash
kustomize build apps/marketplace-ui/overlays/librepod | grep -A2 OPENBAO   # renders both keys
kustomize build apps/openbao/overlays/librepod | grep -A3 "policies-version"
```

Deploy both to dev (`sed` substitution per recipe), then confirm the Job re-ran and applied the policy:

```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config -n openbao delete job openbao-bootstrap   # if apply didn't recreate it
kubectl --kubeconfig ~/.kube/librepod-dev.config -n openbao wait --for=condition=complete job/openbao-bootstrap --timeout=300s
ROOT_TOKEN=$(kubectl --kubeconfig ~/.kube/librepod-dev.config -n openbao get secret openbao-credentials -o jsonpath='{.data.root_token}' | base64 -d)
kubectl --kubeconfig ~/.kube/librepod-dev.config -n openbao exec deploy/openbao -- \
  env BAO_TOKEN="$ROOT_TOKEN" bao policy read marketplace-ui-write-apps   # shows "read"
kubectl --kubeconfig ~/.kube/librepod-dev.config -n marketplace-ui get deploy marketplace-ui -o jsonpath='{.spec.template.spec.containers[0].envFrom}'
```

- [ ] **Step 5: Commit and PR**

```bash
git add apps/marketplace-ui/base/configmap.yaml apps/openbao/
git commit -m "feat(platform): wire marketplace-ui OpenBao env; grant policy read for settings merge"
```

Verify `publish-apps` published `marketplace-ui` and `openbao` (same-version republish — this is what carries the fix to devices without a version bump).

---

## Wave 0.5 — marketplace-ui 0.8.0 (generate + read-merge + legacy mirror)

### Task 2: `generate` on settings items — shared type + resolver

**Files:**
- Modify: `ui/packages/shared/src/types.ts`
- Modify: `ui/packages/server/src/installed/install-settings.ts`
- Test: `ui/packages/server/src/installed/install-settings.spec.ts`

**Interfaces:**
- Produces: `AppSettingItem.generate?: { length: number }`; `resolveSettings(settings, body, stored?, rng?)` — new 3rd param `stored: Record<string, string> | null` (values previously in the OpenBao entry), optional 4th `rng: (length: number) => string` (defaults to crypto hex; tests inject a stub). Return contract unchanged (`{ok, values}` / `{ok:false, errors}`).

- [ ] **Step 1: Write failing tests** in `install-settings.spec.ts`:

```ts
describe('generated items', () => {
  const gen = (length: number) => `x`.repeat(length);
  const settings: AppSettings = {
    items: [
      { name: 'DB_PASSWORD', generate: { length: 40 } },
      { name: 'TOKEN', required: true, sensitive: true },
    ],
  };

  it('generates when no answer, no default, no stored value', () => {
    const r = resolveSettings(settings, { settings: { TOKEN: 't' } }, null, gen);
    expect(r.ok && r.values.DB_PASSWORD).toBe('x'.repeat(40));
  });

  it('reuses the stored value for a generated item', () => {
    const r = resolveSettings(settings, { settings: { TOKEN: 't' } }, { DB_PASSWORD: 'old' }, gen);
    expect(r.ok && r.values.DB_PASSWORD).toBe('old');
  });

  it('an explicit answer wins over the stored value', () => {
    const r = resolveSettings(settings, { settings: { TOKEN: 't', DB_PASSWORD: 'chosen' } }, { DB_PASSWORD: 'old' }, gen);
    expect(r.ok && r.values.DB_PASSWORD).toBe('chosen');
  });

  it('a default wins over the stored value; stored wins over generation', () => {
    const s: AppSettings = { items: [{ name: 'A', default: 'def', generate: { length: 8 } }] };
    expect(resolveSettings(s, {}, { A: 'old' }, gen)).toMatchObject({ ok: true, values: { A: 'old' } });
    expect(resolveSettings(s, {}, null, gen)).toMatchObject({ ok: true, values: { A: 'def' } });
  });

  it('does NOT resurrect stored values for question items', () => {
    const r = resolveSettings(settings, { settings: { TOKEN: '' } }, { TOKEN: 'old-token', DB_PASSWORD: 'old' }, gen);
    // TOKEN answered empty → omitted (required error); stored TOKEN is ignored
    expect(r.ok).toBe(false);
  });

  it('drops stored keys claimed by no item (replace semantics)', () => {
    const r = resolveSettings(settings, { settings: { TOKEN: 't' } }, { STALE: 'z', DB_PASSWORD: 'old' }, gen);
    expect(r.ok && r.values.STALE).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify they fail**

`cd ui && npm test --workspace=packages/server -- src/installed/install-settings.spec.ts` → FAIL (generate unknown, stored ignored).

- [ ] **Step 3: Implement.** In `types.ts` add to `AppSettingItem`:

```ts
  /**
   * Machine-generated secret (DB password, session key): never shown in the
   * dialog. Resolution: answer → default → the value already stored in the
   * OpenBao entry → fresh random of this length. Keep legacy lengths verbatim.
   */
  generate?: { length: number };
```

In `install-settings.ts`: add `stored`/`rng` params; in the items loop, for `raw === undefined/empty` on an item with `generate`, resolve `stored?.[item.name] ?? rng(item.generate.length)` (after `default`), skipping `checkAnswer` for generated values only if the item has no `type`/`options` constraints. Default rng:

```ts
import * as crypto from 'node:crypto';
const defaultRng = (length: number) => crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
```

(The dialog hiding of generated items is Task 4 — server first.)

- [ ] **Step 4: Tests pass.** Run the same command → PASS.
- [ ] **Step 5: Commit** `feat(ui): generated settings items (answer → default → stored → random)`

### Task 3: Hide generated items in the install dialog

**Files:**
- Modify: `ui/packages/client/src/components/InstallDialog.tsx`
- Test: `ui/packages/client/src/components/InstallDialog.test.tsx`

**Interfaces:**
- Consumes: `AppSettingItem.generate` from Task 2.

- [ ] **Step 1: Failing test** — an app with `items: [{name: 'DB_PASSWORD', generate: {length: 40}}, {name: 'TOKEN', required: true, sensitive: true}]` renders a field for `TOKEN` and **no** field/label for `DB_PASSWORD`.
- [ ] **Step 2: Run** `npm run test --workspace=packages/client -- src/components/InstallDialog.test.tsx` → FAIL.
- [ ] **Step 3: Implement** — filter generated items out of the rendered questions list (single `filter((i) => !i.generate)` where items are mapped to inputs).
- [ ] **Step 4: Tests pass** (full client suite: `npm run test:client`).
- [ ] **Step 5: Commit** `feat(ui): hide machine-generated settings from the install dialog`

### Task 4: OpenBao read + read-merge install flow

**Files:**
- Modify: `ui/packages/server/src/installed/openbao.client.ts`
- Modify: `ui/packages/server/src/installed/installed.service.ts`
- Test: `ui/packages/server/src/installed/openbao.client.spec.ts`, `ui/packages/server/src/installed/installed.service.spec.ts`

**Interfaces:**
- Produces: `OpenBaoClient.readAppSettings(app): Promise<Record<string, string> | null>` — KV v2 GET `…/v1/<mount>/data/apps/<app>`, unwraps `{data:{data:{…}}}`, `404 → null`, transient failures throw `OpenBaoUnavailableError`/`OpenBaoMisconfiguredError` exactly like the write path (reuse `failure()`).
- `InstalledService.install()` flow for apps with settings becomes: `stored = await openBao.readAppSettings(appName)` → `resolveSettings(app.settings, body, stored)` → `writeAppSettings(appName, resolved.values)` (unchanged signature).

- [ ] **Step 1: Failing tests** — client: 200 with nested data → map; 404 → null; 503 → `OpenBaoUnavailableError`; 403-then-retry reuse of the cached token (mirror the write tests' structure). Service: install reads the entry first and passes it to the resolver; read failure (`OpenBaoUnavailableError`) → 503 like the write.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**

In `openbao.client.ts` add (with a `private async get(url, headers)` helper mirroring `post`, and the same 403-relogin-once logic):

```ts
/** The app's current settings entry, or null when it was never written. */
async readAppSettings(app: string): Promise<Record<string, string> | null> {
  if (!this.addr) throw new OpenBaoMisconfiguredError('OPENBAO_ADDR is not set');
  const mount = this.config.get<string>('OPENBAO_KV_MOUNT', 'secret');
  const url = `${this.addr}/v1/${mount}/data/apps/${encodeURIComponent(app)}`;
  let res = await this.get(url, { 'X-Vault-Token': await this.clientToken() });
  if (res.status === 404) return null;
  if (res.status === 403 && this.token) {
    this.token = undefined;
    res = await this.get(url, { 'X-Vault-Token': await this.clientToken() });
    if (res.status === 404) return null;
  }
  if (!res.ok) throw failure(`read apps/${app}`, res.status);
  const body = (await res.json()) as { data?: { data?: Record<string, string> } };
  return body.data?.data ?? {};
}
```

In `installed.service.ts` step 3, before `resolveSettings`:

```ts
let stored: Record<string, string> | null = null;
try {
  stored = await this.openBao.readAppSettings(appName);
} catch (err) {
  // same 503/500 mapping as the write below — factor the two throws into a
  // small private helper so read and write cannot drift apart
}
const resolved = resolveSettings(app.settings, body, stored);
```

- [ ] **Step 4: Tests pass** (`npm test` — full server suite).
- [ ] **Step 5: Commit** `feat(ui): install reads the OpenBao entry first so generated values survive reinstall`

### Task 5: Legacy Gogs secret mirror + uninstall bridge

**Files:**
- Create: `ui/packages/server/src/installed/legacy-secret-mirror.ts`
- Modify: `ui/packages/server/src/installed/user-apps-repo.service.ts` (expose reading `apps/<name>/secret.yaml`)
- Modify: `ui/packages/server/src/installed/installed.service.ts` (uninstall hook)
- Modify: `ui/packages/server/src/installed/installed.module.ts` (provider wiring)
- Test: `ui/packages/server/src/installed/legacy-secret-mirror.spec.ts`, extend `installed.service.spec.ts`

**Interfaces:**
- Produces: `LegacySecretMirror.mirrorOnce(): Promise<{ apps: number; keys: number }>` — reads every `apps/*/secret.yaml` in the user-apps working copy, parses `stringData`, and for each key **absent** from the app's OpenBao entry writes it (merge-if-absent; existing OpenBao values always win). Skips values that are empty or still-literal `${VAR}` placeholders. Never throws to its callers (logs); callers: `onModuleInit` (fire-and-forget after repo init), a 1h `setInterval`, and `InstalledService.uninstall()` **before** `removeApp` (awaited, best-effort).
- Consumes: `OpenBaoClient.readAppSettings`/`writeAppSettings` (Task 4), `UserAppsRepoService`.

- [ ] **Step 1: Failing tests** for the pure logic (extract the parse/merge into an exported pure function `mergeLegacyIntoStored(fileContents: string, stored: Record<string,string> | null)` returning the merged map or null when nothing to add):

```ts
it('merges absent keys only', () => {
  expect(mergeLegacyIntoStored('stringData:\n  A: "1"\n  B: "2"\n', { B: 'kept' }))
    .toEqual({ A: '1', B: 'kept' });
});
it('skips empty and unsubstituted values', () => {
  expect(mergeLegacyIntoStored('stringData:\n  A: ""\n  B: "${NOPE}"\n  C: "ok"\n', null))
    .toEqual({ C: 'ok' });
});
it('returns null when nothing new', () => {
  expect(mergeLegacyIntoStored('stringData:\n  A: "1"\n', { A: '1' })).toBeNull();
});
```

Plus service tests: uninstall calls the mirror before `removeApp` (ordering assertion via a spy); mirror throwing does not fail uninstall; install never calls the mirror.

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
  - YAML parsing: check whether the server already depends on a YAML lib (`js-yaml`/`yaml` in `ui/packages/server/package.json`); if none, add `yaml` (tiny, pure). Parse with it — never regex.
  - `UserAppsRepoService`: add `readAppFile(app: string, file: string): Promise<string | null>` — reads from the working copy, null when absent.
  - `LegacySecretMirror`: iterate `listInstalledApps()`, read `secret.yaml`, `mergeLegacyIntoStored` against `readAppSettings`, `writeAppSettings` when non-null. Wire `onModuleInit` (catch+log, don't block boot) and `setInterval(..., 60 * 60 * 1000).unref()`.
  - `uninstall()`: after the installed check, before `removeApp`:

```ts
      // Snapshot legacy secret values into OpenBao BEFORE deleting the Gogs
      // files: after removeApp the values exist nowhere (the flux-system
      // Secret is pruned with the repo path), and a reinstall on surviving
      // NFS data must reuse them. Best-effort: a failure logs and proceeds.
      await this.legacyMirror.snapshotApp(appName).catch((err) =>
        this.logger.warn(`legacy secret snapshot failed for ${appName}: ${err.message}`),
      );
```

  (`snapshotApp` = mirror logic scoped to one app.)

- [ ] **Step 4: Tests pass** (`npm test`).
- [ ] **Step 5: Tier 1 fixture:** extend the renovate fixture app with a legacy `templates.secret` shape is NOT possible post-migration — instead the mirror is covered by unit tests + the manual dev verification in Task 19. Run `npm run test:e2e` to prove nothing regressed.
- [ ] **Step 6: Commit** `feat(ui): mirror legacy Gogs secrets into OpenBao (boot, hourly, at uninstall)`

### Task 6: Release marketplace-ui 0.8.0

**Files:**
- Modify: `ui/package.json` (`"version": "0.8.0"`), `apps/marketplace-ui/metadata.yaml` (`spec.version: "0.8.0"`), `apps/marketplace-ui/overlays/librepod/kustomization.yaml` (`images[].newTag: "0.8.0"`), `infrastructure/system-apps/marketplace-ui.yaml` (`ref.tag: "0.8.0"`)

- [ ] **Step 1:** Bump all four in one commit (self-built app triple pin + product version; grep for `0.7.0` across the four files to catch strays).
- [ ] **Step 2:** Full test suite green (`cd ui && npm test && npm run test:client && npm run test:e2e`).
- [ ] **Step 3:** Verify CI built the image and published the app artifact (`gh run watch` on the push; then `gh api /users/librepod/packages/container/marketplace-ui/versions` or check the workflow logs). Fix via re-run if needed.
- [ ] **Step 4:** Deploy to dev and confirm the mirror ran: `kubectl --kubeconfig ~/.kube/librepod-dev.config -n marketplace-ui logs deploy/marketplace-ui | grep -i mirror` and spot-check one OpenBao entry (e.g. an installed legacy app's `bao kv get apps/apps/<app>` shows the live values, keys matching the Gogs `secret.yaml`).
- [ ] **Step 5:** Commit `chore(marketplace-ui): release 0.8.0 (generate + read-merge + legacy mirror)`

**GATE:** do not merge any Wave 1+ task until 0.8.0 is published and verified on dev.

---

## Wave 1 — pilots (the two wiring patterns, end to end)

### Task 7: renovate (Kustomize pilot; also fixes its broken install)

**Files:**
- Modify: `apps/renovate/metadata.yaml`
- Create: `apps/renovate/base/externalsecret.yaml`
- Delete: `apps/renovate/base/secret.yaml`
- Modify: `apps/renovate/base/kustomization.yaml`, `apps/renovate/base/cronjob.yaml`, `apps/renovate/base/renovate.env`

**Interfaces:** Recipe K. Per-app deltas:

- [ ] **Step 1: metadata.yaml** — apply Recipe K with exactly:

```yaml
  settings:
    allowCustom: true
    items:
      - name: RENOVATE_TOKEN
        label: "Access token"
        description: "Personal Access Token for your Git platform (repo, pull-request and issues scopes)."
        sensitive: true
        required: true
      - name: RENOVATE_GITHUB_COM_TOKEN
        label: "GitHub.com token"
        description: "PAT for github.com to fetch changelogs when your platform is NOT github.com. Leave empty when targeting github.com."
        sensitive: true
```

Remove `params`, `secrets`, `templates.secret`, the `substituteFrom` block, `- secret.yaml` from `templates.kustomization`, and the `LOG_LEVEL: "${LOG_LEVEL}"` line from `postBuild.substitute` in `templates.release` (keep `BASE_DOMAIN` if present — check the current release template; drop only what referenced removed vars).

- [ ] **Step 2: base changes** — create `externalsecret.yaml` per Recipe K (`renovate-settings`, key `apps/renovate`); delete `secret.yaml`; swap the resources entry; in `renovate.env` replace `LOG_LEVEL=${LOG_LEVEL}` with `LOG_LEVEL=info` (the Flux self-referential substitute is a silent no-op today — the literal default is what actually ships).
- [ ] **Step 3: cronjob.yaml** — envFrom becomes `[configMapRef: renovate, secretRef: renovate-settings]`; delete the old `secretRef: renovate-env`.
- [ ] **Step 4: Verify per the recipe** — build; seed `apps/apps/renovate RENOVATE_TOKEN=t_dev RENOVATE_GITHUB_COM_TOKEN=g_dev` on dev; apply; the CronJob's next Job run has both env vars; `ExternalSecret/renovate-settings Ready=True`. Then the UI path: uninstall (if installed) + install via dialog with a token → assert the OpenBao entry and that the token never appears in the Gogs repo (`kubectl -n flux-system exec…` or clone check — Tier 1 already asserts this; do a spot check).
- [ ] **Step 5: Fixture** — `catalog.fixture.yaml`'s renovate already has `settings`; align its items with the new metadata (add nothing generated; keep the two questions).
- [ ] **Step 6: Commit** `feat(renovate): migrate to OpenBao settings (install questions + ExternalSecret)`; merge-checklist.

### Task 8: open-webui (Helm pilot; proves `valuesFrom` boolean casting)

**Files:**
- Modify: `apps/open-webui/metadata.yaml`, `apps/open-webui/overlays/librepod/helmrelease.yaml`
- Create: `apps/open-webui/base/externalsecret.yaml`
- Modify: `apps/open-webui/base/kustomization.yaml`

**Interfaces:** Recipe H. Per-app deltas:

- [ ] **Step 1: metadata.yaml** — remove `params` entirely (both `BASE_DOMAIN` — dead — and `OLLAMA_ENABLED`); add:

```yaml
  settings:
    items:
      - name: OLLAMA_ENABLED
        label: "Enable Ollama"
        description: "Run a local Ollama sidecar for local LLMs. Needs the ollama host to be reachable; off by default."
        type: boolean
        default: false
```

(`allowCustom` only if the chart exposes an `extraEnvFrom`-style value — check the chart's values at the pinned version; if absent, omit `allowCustom`.)

- [ ] **Step 2: HelmRelease** — in `values`, delete the `ollama.enabled` key (leave the rest of the `ollama:` block if it carries other config; if `enabled` was its only key, delete the block). Add:

```yaml
  valuesFrom:
    - kind: Secret
      name: open-webui-settings
      valuesKey: OLLAMA_ENABLED
      targetPath: ollama.enabled
```

- [ ] **Step 3: base** — `externalsecret.yaml` (`open-webui-settings`, key `apps/open-webui`) + resources entry.
- [ ] **Step 4: The §8 risk gate — boolean casting.** `valuesFrom` delivers the string `"false"`. Helm chart templates using `if .Values.ollama.enabled` treat a non-empty string as TRUE — a `"false"` that renders ollama ON is a migration-breaking lie. Verify on dev BOTH ways: seed the entry with `OLLAMA_ENABLED=false` → apply → assert no ollama pod; then `OLLAMA_ENABLED=true` → assert the ollama deployment exists. **If string-"false" renders truthy:** stop, revert this task, and record the finding (fallback: no boolean questions on Helm apps until charts accept string bools; open-webui ships without the question — keep its dead-param removal only).
- [ ] **Step 5: Verify per recipe** (build with `--enable-helm`), commit `feat(open-webui): migrate OLLAMA_ENABLED to OpenBao settings (HelmRelease valuesFrom)`, merge-checklist.

**Note (explicitly out of scope here):** open-webui's committed `WEBUI_ADMIN_PASSWORD: "123"` side-finding gets its own small follow-up after the mechanism is proven — do not bundle.

---

## Wave 2 — remaining user-supplied apps

### Task 9: xray-checker

**Files:** metadata.yaml; create `base/externalsecret.yaml`; delete `base/secret.yaml`; modify `base/kustomization.yaml`, `base/deployment.yaml`.

- [ ] **Step 1: metadata** — Recipe K; one question:

```yaml
  settings:
    items:
      - name: SUBSCRIPTION_URL
        label: "Subscription URL"
        description: "The xray subscription URL to monitor."
        sensitive: true        # URLs commonly embed credentials
        required: true
```

- [ ] **Step 2: base** — Recipe K wiring; deployment `envFrom: [configMapRef xray-checker, secretRef xray-checker-settings]`; remove old `secretRef: xray-checker-secret`.
- [ ] **Step 3: Verify per recipe; commit** `feat(xray-checker): migrate to OpenBao settings`; merge-checklist. If installed on dev, data-safety assertion is trivially N/A (no persistence).

### Task 10: frpc

**Files:** metadata.yaml; create `base/externalsecret.yaml`; delete `base/secret.yaml`; modify `base/kustomization.yaml`, `base/deployment.yaml`, `base/frp.toml`.

- [ ] **Step 1: Investigate token delivery.** Today `${FRP_AUTH_TOKEN}` is Flux-substituted into the `frp.toml` ConfigMap, and `secret.yaml` (`frpc-auth`) exists but check how `deployment.yaml:47` (`secretName: frpc-auth`-ish reference) consumes it. Determine the pinned frpc version's config templating support: frp ≥ 0.52 supports Go-templated `{{ .Envs.FRP_AUTH_TOKEN }}` in config files. Confirm with the pinned tag's docs/release notes (`WebFetch` the frp docs page for that version).
- [ ] **Step 2: metadata** — one question, `required: true`, `sensitive: true`, no `allowCustom` (custom env vars cannot reach a toml config that doesn't reference them).
- [ ] **Step 3: wiring** — `frp.toml`: replace the token line with the template expression for the pinned version (e.g. `auth.token = "{{ .Envs.FRP_AUTH_TOKEN }}"`); deployment envFrom gains `secretRef: frpc-settings` so the env var exists; delete `secret.yaml`. If (and only if) the pinned frpc cannot template envs and has no CLI equivalent: keep this app's secret.yaml mechanism, document why inline, and skip the migration (leave metadata on legacy shape) — frpc is not currently installable from the UI anyway (system-apps comment), so there is no user pressure.
- [ ] **Step 4: Verify per recipe** (assert the rendered frpc.toml inside the pod resolves the token: `kubectl -n frpc exec … -- cat /etc/frp/frpc.toml` shows the real token from OpenBao). Commit `feat(frpc): migrate FRP auth token to OpenBao settings`; merge-checklist.

---

## Wave 3 — low-risk generated apps

### Task 11: vaultwarden

**Files:** metadata.yaml; create `base/externalsecret.yaml`; modify `base/kustomization.yaml`, `base/deployment.yaml`, `base/vaultwarden.env`.

- [ ] **Step 1: metadata** — Recipe K with:

```yaml
  settings:
    allowCustom: true          # vaultwarden is env-var-driven; power users win here
    items:
      - name: ADMIN_TOKEN
        label: "Admin token"
        description: "Token for the /admin panel. Leave empty to auto-generate."
        sensitive: true
        generate:
          length: 64
```

- [ ] **Step 2: base** — delete the `${ADMIN_TOKEN}` line from `vaultwarden.env` (the settings Secret supplies it; a leftover placeholder would win env precedence battles or render literally); envFrom gains `secretRef: vaultwarden-settings` **after** the ConfigMap (vaultwarden reads ADMIN_TOKEN by env name — no secretKeyRef existed for it; verify with `grep -n ADMIN_TOKEN apps/vaultwarden/base/deployment.yaml` and convert any hit).
- [ ] **Step 3: Verify per recipe.** vaultwarden is installed on dev/prod with data: run the data-safety assertion (admin token value identical before/after — a changed token only locks /admin, but assert preservation anyway). Commit `feat(vaultwarden): migrate ADMIN_TOKEN to OpenBao settings`; update the Tier 1 fixture (vaultwarden appears in it — replace its `templates`/`secrets` shape with the settings shape, or drop it from the fixture if its only role was templates coverage — check what the fixture's tests assert first).

### Task 12: netronome

**Files:** metadata.yaml; create `base/externalsecret.yaml`; delete `base/secret.yaml`; modify `base/kustomization.yaml`, `base/deployment.yaml`.

- [ ] **Step 1: metadata** — Recipe K; one generated item `SESSION_SECRET`, `generate: {length: 64}` (no dialog noise).
- [ ] **Step 2: base** — deployment: remove `secretRef: netronome-secret` and any `secretKeyRef` reading it (map each removed keyRef to the envFrom settings Secret — key names already match env names); envFrom `[netronome ConfigMap, netronome-settings]`.
- [ ] **Step 3: Verify per recipe** (session secret preservation assert if installed); commit `feat(netronome): migrate SESSION_SECRET to OpenBao settings`; merge-checklist.

### Task 13: happy-server

**Files:** `apps/happy-server/metadata.yaml` (and possibly overlay wiring — see Step 1).

- [ ] **Step 1: Investigate whether the two declared secrets are dead.** Earlier survey found `${…}` placeholders in NO happy-server manifest, and no `HAPPY_SERVER_*` consumer. Check `overlays/librepod/happy-server-secret.env` content and the overlay kustomization (what generator consumes it, which vars it carries). Two outcomes:
  - **Dead** (values never reach a workload): remove `params`, `secrets`, `templates.secret`, `substituteFrom` from metadata.yaml; **no ExternalSecret, no base changes**. Note in the commit message that the secrets were declared-but-undelivered.
  - **Live** (the overlay env file carries them via a generator + substituteFrom): apply Recipe K with two generated items (`HAPPY_SERVER_SECRET` 64, `HAPPY_SERVER_PASSWORD` 32) and wire the overlay generator's consumer to `happy-server-settings` instead.
- [ ] **Step 2: Verify per recipe** (whichever branch); commit `feat(happy-server): drop dead secret declarations / migrate to OpenBao settings`; merge-checklist.

---

## Wave 4 — DB-coupled generated apps (order: converge-covered first, preservation-critical last)

**Common shape for litellm / immich / remnawave:** the secret values are Flux-substituted into `.env` files today (`<app>.env`, `components/postgres/postgres.env`) — i.e. plaintext in ConfigMaps. Migration deletes those placeholder lines and moves delivery to the settings Secret via envFrom on EVERY container that consumed them, including the `converge-db-password` container (the skill requires it to read the same env as the postgres container — it gains the same `envFrom: […, <app>-settings]`).

### Task 14: litellm

**Files:** metadata.yaml; create `base/externalsecret.yaml`; delete `base/secret.yaml`; modify `base/kustomization.yaml`, `base/deployment.yaml`, `base/litellm.env`, `components/postgres/deployment.yaml`, `components/postgres/postgres.env`.

- [ ] **Step 1: metadata** — Recipe K; two generated items (`LITELLM_SALT_KEY` 64, `DB_PASSWORD` 40); `allowCustom: false` (litellm's config is file/salt-driven; env override semantics unclear — keep it closed).
- [ ] **Step 2: base + postgres component** — delete `${LITELLM_SALT_KEY}`/`${DB_PASSWORD}` lines from the two `.env` files; litellm deployment: convert the two `secretKeyRef`s (old secret) to the settings Secret (either envFrom or `secretKeyRef: {name: litellm-settings, key: …}` — keep explicit keyRefs where the env name differs from the key); postgres + converge-db-password containers: envFrom appends `litellm-settings` **last** (custom vars override postgres defaults too).
- [ ] **Step 3: Verify per recipe + the DB data-safety assertion** (dev has litellm with data: the OpenBao entry value must equal the live `<app>-config`/Gogs value after migration; postgres auth still works). Commit `feat(litellm): migrate salt key + DB password to OpenBao settings`; Tier 1 fixture: litellm appears in it — update its fixture shape like vaultwarden's.

### Task 15: immich

Same shape as litellm (single generated item `DB_PASSWORD` 40; `base/immich.env` placeholder; `components/postgres/` incl. converge container; immich deployment envFrom gains `immich-settings` last). Extra care: immich's ML/server containers may read `DB_PASSWORD` from the shared ConfigMap via envFrom — confirm each consumer gets the Secret after the `.env` line is deleted (`grep -rn DB_PASSWORD apps/immich/`). Verify per recipe + data-safety assertion (immich is live on prod with NFS-backed DB). Commit `feat(immich): migrate DB password to OpenBao settings`.

### Task 16: remnawave

Same shape (`APP_SECRET` 64 + `DB_PASSWORD` 40; `base/remnawave.env`, `components/postgres/postgres.env` both lose placeholders; deployment + postgres + converge get `remnawave-settings` last). **Extra investigation:** `components/tailscale/tailscale.env` contains a `${…}` placeholder — identify the var; if it's `BASE_DOMAIN`, leave it (platform var); if it references a secret/param that nothing provides (dead), replace with the literal it should be and note it in the commit. Verify per recipe + data-safety. Commit `feat(remnawave): migrate app secret + DB password to OpenBao settings`.

### Task 17: obsidian-livesync (CouchDB — NO converge container; preservation-critical)

**Files:** metadata.yaml; create `base/externalsecret.yaml`; delete `base/secret.yaml`; modify `base/kustomization.yaml`, `base/deployment.yaml`, `base/job.yaml`, `base/init-script.sh`.

- [ ] **Step 1: metadata** — two generated items (`COUCHDB_PASSWORD` 32, `COUCHDB_SECRET` 32).
- [ ] **Step 2: workloads** — deployment + job: replace `secretKeyRef`s of the old secret with envFrom/settings keyRefs; both must carry the Secret (the job re-creates the CouchDB admin on an empty volume and reads the password on an existing one).
- [ ] **Step 3: init-script.sh** — read it. If it references the password as a Flux-substituted `${COUCHDB_PASSWORD}` inside a ConfigMap'd script, switch it to runtime shell expansion (`$COUCHDB_PASSWORD` — no braces, per the Flux-substitute trap) and make sure the container running it has the env (envFrom settings Secret). If it's already shell-style, nothing to do.
- [ ] **Step 4: Verify per recipe + data-safety assertion with extra rigor** (no self-healing exists: assert OpenBao value == pre-migration live value, pod Running, CouchDB auth OK in logs, and a document sync round-trip if practical on dev). Commit `feat(obsidian-livesync): migrate CouchDB credentials to OpenBao settings`.

### Task 18: seafile (5 secrets, duplicated key mapping — most complex, last)

**Files:** metadata.yaml; create `base/externalsecret.yaml`; delete `base/secret.yaml`; modify `base/kustomization.yaml`, `base/deployment.yaml`, `components/mysql/deployment.yaml`, and any init Job consuming `INIT_*`.

- [ ] **Step 1: metadata** — five generated items, legacy lengths verbatim:

```yaml
  settings:
    items:
      - name: MYSQL_ROOT_PASSWORD
        generate: { length: 32 }
      - name: SEAFILE_MYSQL_DB_PASSWORD
        generate: { length: 32 }
      - name: REDIS_PASSWORD
        generate: { length: 32 }
      - name: INIT_SEAFILE_ADMIN_PASSWORD
        generate: { length: 32 }
      - name: JWT_PRIVATE_KEY
        generate: { length: 40 }
```

  (Note in the item comments: `JWT_PRIVATE_KEY` is a random opaque string today, not a PEM key — preserve semantics, do not "fix" to a real key in this migration.)
- [ ] **Step 2: the duplicated key.** The legacy secret maps `${MYSQL_ROOT_PASSWORD}` onto TWO keys: `MYSQL_ROOT_PASSWORD` and `INIT_SEAFILE_MYSQL_ROOT_PASSWORD` — they MUST stay equal (init uses one, runtime the other; divergence locks seafile out of its own DB). `dataFrom.extract` cannot duplicate a key, so this app's ExternalSecret uses `data[]` entries instead:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: seafile-settings
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: ClusterSecretStore, name: openbao }
  target: { name: seafile-settings }
  data:
    - secretKey: MYSQL_ROOT_PASSWORD
      remoteRef: { key: apps/seafile, property: MYSQL_ROOT_PASSWORD }
    - secretKey: INIT_SEAFILE_MYSQL_ROOT_PASSWORD
      remoteRef: { key: apps/seafile, property: MYSQL_ROOT_PASSWORD }   # same source: stays equal
    - secretKey: SEAFILE_MYSQL_DB_PASSWORD
      remoteRef: { key: apps/seafile, property: SEAFILE_MYSQL_DB_PASSWORD }
    - secretKey: REDIS_PASSWORD
      remoteRef: { key: apps/seafile, property: REDIS_PASSWORD }
    - secretKey: INIT_SEAFILE_ADMIN_PASSWORD
      remoteRef: { key: apps/seafile, property: INIT_SEAFILE_ADMIN_PASSWORD }
    - secretKey: JWT_PRIVATE_KEY
      remoteRef: { key: apps/seafile, property: JWT_PRIVATE_KEY }
```

  **Mirror interaction:** the legacy Gogs file contains BOTH root-password keys with the same value; the mirror writes both into OpenBao; the generated items above declare only `MYSQL_ROOT_PASSWORD`, so a FRESH install generates one value and the ExternalSecret derives the second — equality holds on both fresh and migrated installs. (This is why the duplicate lives in the ExternalSecret, not in two independent generated items.)
- [ ] **Step 3: workloads** — map every consumer: `base/deployment.yaml` (4× `secretKeyRef` + 1 `secretRef` of the old secret) and `components/mysql/deployment.yaml` (`secretKeyRef`) all repoint at `seafile-settings` keys; any init Job reading `INIT_SEAFILE_ADMIN_PASSWORD` likewise.
- [ ] **Step 4: Verify per recipe + the strictest data-safety pass** (MariaDB + admin password + JWT all preserved; seafile login works on dev after migration). Run the full `verify-app` skill flow for seafile on dev. Commit `feat(seafile): migrate all credentials to OpenBao settings`.

---

## Wave 5 — cleanup, docs, fleet verification

### Task 19: Strip dead `params` from every remaining app

**Files:** Modify `apps/*/metadata.yaml` for every app still carrying `params` (all except those migrated in Tasks 7–18, which already dropped it).

- [ ] **Step 1:** For each app, delete the whole `params:` block (mechanical; a small script helps, review the diff by eye):

```bash
for f in apps/*/metadata.yaml; do yq -i 'del(.spec.params)' "$f"; done
git diff --stat
```

- [ ] **Step 2:** Sanity: `yq '.spec.params' apps/*/metadata.yaml` prints `null` everywhere; `kustomize build` untouched (metadata.yaml is not a kustomize resource); CI regenerates the catalog without params.
- [ ] **Step 3:** Commit `chore(apps): drop dead params blocks (installer never read them)`. One commit is fine — this is metadata-only, no manifests.

### Task 20: Remove params from the catalog pipeline and shared types

**Files:**
- Modify: `scripts/generate-catalog.sh`, `scripts/test-generate-catalog.sh`
- Modify: `ui/packages/shared/src/types.ts` (`AppParam`, `params?` on `CatalogApp`)
- Modify: any server/client reference (survey first: `grep -rn "AppParam\|\.params" ui/packages/server/src ui/packages/client/src | grep -v useSearchParams`)

- [ ] **Step 1:** Script: delete the params extraction branch + its tests' expectations; run `bash ./scripts/generate-catalog.sh` and `bash ./scripts/test-generate-catalog.sh` (NixOS: run via `bash ./scripts/…`, no `/bin/bash`).
- [ ] **Step 2:** Types: remove `AppParam` and `params?`; fix compile errors (the client renders no params — verified: only `useSearchParams` URL-param usage exists).
- [ ] **Step 3:** Full ui suite green; commit `chore(catalog): drop params from catalog generation and shared types`.

### Task 21: Docs — skill, decisions log, ui CLAUDE.md

**Files:**
- Modify: `.claude/skills/librepod-app/SKILL.md`
- Modify: `docs/DECISIONS_LOG.md`
- Modify: `ui/CLAUDE.md`

- [ ] **Step 1: skill** — add a "Settings (install questions + generated secrets)" section: the `settings` contract (items, `generate`, `allowCustom`, one-owner rule D6, `BASE_DOMAIN` reserved), the ExternalSecret + envFrom/valuesFrom wiring for both app types, valuesFrom-vs-inline-values precedence, the verification note (seed `apps/<app>` in OpenBao before manual kubectl verification), generated-item hiding, and that converge-db-password is unchanged (it reads the settings Secret now). Update the Secrets section to demote the legacy `secrets[]` + `templates.secret` path to "legacy — no new apps".
- [ ] **Step 2: decisions log** — rows: generated values live in OpenBao and survive reinstall (read-merge; extends D2/D7 to `generate`), and the legacy Gogs mirror (why it exists, when it can be deleted: once no cluster runs a pre-0.8.0 marketplace-ui against a migrated catalog).
- [ ] **Step 3: ui/CLAUDE.md** — install-flow section: read → resolve(with stored) → write; the mirror (boot/hourly/uninstall); env table unchanged except noting `OPENBAO_KV_MOUNT` is `apps` in cluster manifests.
- [ ] **Step 4:** Commit `docs: settings migration — skill, decisions, ui docs`.

### Task 22: Fleet verification + Tier 2 advisory

- [ ] **Step 1: Tier 1** — `cd ui && npm run test:e2e:ui` green with the updated fixtures.
- [ ] **Step 2: Tier 2 (advisory, k3d)** — `npm run test:e2e:ui:cluster` — the bootstrap includes openbao + ESO (pinned system apps), so a renovate install through the UI should reach `running`. If the suite has no settings-app install coverage, add one spec asserting the dialog → install → `running` → `kubectl -n renovate get externalsecret` Ready (model it on the existing cluster-smoke spec; keep it advisory).
- [ ] **Step 3: dev end-to-end mirror drill** — simulate a straggler: manually commit an `apps/<any>/secret.yaml` into the dev user-apps Gogs repo (via the gogs UI/git as flux user), restart the marketplace-ui pod (or wait ≤1h), assert the OpenBao entry appeared with those values. Then delete the file again.
- [ ] **Step 4: prod rollout confirmation** — for each device: marketplace-ui 0.8.0 deployed (system-apps pin), openbao policies include `read`, and after each app wave merges, the installed instances reconcile with `ExternalSecret Ready=True` and pods stable. Watch: `kubectl get externalsecret -A`, `kubectl get pods -A | grep -v Running`.
- [ ] **Step 5:** Record residual risks in the plan's shadow (not code): older-bootstrap devices (pre-openbao) can list migrated apps but fail to install (accepted, spec D9); the mirror is kept as a safety net.

---

## Rollout safety summary (why no data is lost)

| Scenario | Mechanism protecting values |
|---|---|
| App installed, migration artifact arrives in place | Mirror (boot + hourly) already wrote the entry; ESO syncs the SAME values; pods restart with identical env |
| App installed, user uninstalls, reinstalls after migration | Uninstall bridge snapshots Gogs `secret.yaml` → OpenBao BEFORE deletion; install read-merge reuses the entry |
| App installed between mirror deploy and its migration wave, then uninstalls | Same bridge (reads the still-present Gogs file at uninstall) |
| Fresh install, never installed before | Generate new values — correct, nothing to preserve |
| Mirror/OpenBao hiccup during in-place migration | ExternalSecret waits (`CreateContainerConfigError`), self-heals on the next mirror tick; values never change under living data |
| Postgres password drift despite everything | converge-db-password container heals it (litellm, immich, remnawave); CouchDB/MariaDB apps rely on the preservation paths above (hence their strict assertions) |

## Self-review notes

- Spec coverage: settings contract §5.1 (Task 2–3), storage/delivery §5.2 (Recipe K/H), installer §5.3 read-merge extension (Task 4), platform §5.5 gaps (Task 1), rollout steps 4–5 (Tasks 7–8, 21), §10 side-findings (read-merge + mirror address the reinstall-regeneration finding; open-webui password side-finding deliberately deferred). The spec's §2 out-of-scope "generated values in settings" IS this plan's core — design decisions confirmed with the user (generate-on-item, Gogs mirror, params removal).
- Type consistency: `resolveSettings(settings, body, stored?, rng?)` used consistently; `readAppSettings` name used in Tasks 4, 5; `<app>-settings` Secret naming consistent across recipe and tasks.
- No placeholders: every task names files and exact content; the two investigation-gated steps (happy-server liveness, frpc templating) spell out both outcomes' actions.
