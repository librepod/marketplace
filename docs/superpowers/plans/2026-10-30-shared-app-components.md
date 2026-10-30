# Shared App Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick optional, separately versioned networking components
(gluetun, sing-box, tailscale, frp-expose) in the install dialog. The installer
then composes them into the app in-cluster with a Flux ArtifactGenerator.

**Architecture:**
- The repo layer is a `components/<name>/` library. Each component is a kustomize `kind: Component` plus a `component.yaml` descriptor.
- Each component is published as its own cosign-signed OCI artifact.
- `catalog.yaml` carries a top-level `components:` map and a per-app opt-in list.
- When a user selects components, marketplace-ui adds pinned component OCIRepositories and an ArtifactGenerator to the install, and points the app Kustomization at the generated ExternalArtifact with `spec.components`.
- Installs with no components are unchanged.

**Tech Stack:**
- Bash, with `yq` v4 (mikefarah) and `kustomize` from `shell.nix`
- GitHub Actions, using `flux push artifact` and cosign
- NestJS 11 + vitest on the server; js-yaml is already a dependency
- React 19 + vitest/testing-library on the client
- Flux source-watcher `source.extensions.fluxcd.io/v1beta1`

**Spec:** `docs/superpowers/specs/2026-10-30-shared-app-components-design.md`.
Read it first. This plan names the decisions the spec leaves open and cites
spec sections rather than repeating their values.

## Global Constraints

- **Public repo.** Never name personal devices, hosts, IPs, domains or relays in code, comments, commits or docs.
- **Shell commands:** use non-interactive forms only (`cp -f`, `mv -f`, `rm -f`, `rm -rf`).
- **CI logic lives in `scripts/<name>.sh`.** Each script has `set -euo pipefail`, a usage line and `cd "$(dirname "$0")/.."`, plus a `scripts/test-<name>.sh` (throwaway fixture tree, `fail()` helper, `trap rm`). Workflow YAML holds only `env:` wiring and one-line `run:` calls. Destructive actions are opt-in flags (`--push`).
- **Task tracking:** track it in `bd` (one issue per task), not TodoWrite. The default profile is conservative: commit on the feature branch and never push without the user's go-ahead.
- **Patch target annotation:** `librepod.org/component-target: "true"`. Component patches select it with `target.annotationSelector: librepod.org/component-target=true`.
- **Sidecar container name equals the component name** (`gluetun`, `sing-box`, `tailscale`). The CI check relies on this.
- **Component manifests:**
  - no `namespace:`;
  - fixed resource names;
  - every `${VAR}` has a default (`${VAR:=default}`);
  - `INSTANCE_NAME` is always supplied by the installer and equals the app name today.
- **Reserved substitution names**, never usable as component values: `BASE_DOMAIN`, `DEVICE_IP`, `INSTANCE_NAME`, `FRP_DOMAIN`.
- **Component OCI repo:** `oci://ghcr.io/librepod/marketplace/components/<name>`. Tags are `<version>` and `latest` on master, `pr-<n>` on PRs.
- **Component settings:**
  - stored in OpenBao at `apps/<app>/<component>`;
  - delivered by the component's own ExternalSecret `<component>-settings` (`refreshInterval: 5m`, ClusterSecretStore `openbao`, `dataFrom.extract.key: apps/${INSTANCE_NAME:=app}/<component>`);
  - never written to `apps/<app>` or `<app>-settings`.
- **Generated artifact layout:** the app root, plus `shared-components/<component>/`. The Kustomization lists `../../shared-components/<component>`, relative to `./overlays/librepod`.
- **No app version bumps.** App changes ship as rolling re-pushes of the current tags. Never commit a regenerated `catalog.yaml`, because CI owns it.
- **gluetun outbound subnets:** `FIREWALL_OUTBOUND_SUBNETS: "10.42.0.0/16,10.43.0.0/16"`.
- **Known limitations are help text.** Each descriptor's `description` carries the spec's known limitations for that component in at most two sentences, because that is the help text the dialog shows.
- **Install values** (`from: install`) must match the descriptor `pattern` **and** the server-side `SAFE_VALUE` (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/`). They become bare YAML scalars under two levels of Flux substitution, so free text must never reach them.

## Review Focus

1. **A `from: install` value carrying `${X}`, `: `, a space or a newline must get a 400 and never reach `release.yaml`**, even when the descriptor's pattern is loose. Test in Task 8: `rejects install values outside SAFE_VALUE even when the pattern allows them`.
2. **A component secret must never land in the app's own OpenBao entry or Secret.** Test in Task 9: `writes component settings to apps/<app>/<component> and never into apps/<app>`.
3. **An app that lists components but has no `settings` must still open the install dialog and install**, with no GET to `/settings`, which 404s. Test in Task 10: `opens the dialog for a settings-less app with components without fetching settings`.
4. **An install with no components, whether `components` is absent or `[]`, must write exactly today's files.** Test in Task 9: `keeps plain installs byte-identical`.
5. **A render failure must leave nothing behind:** neither an OpenBao write nor a commit. Render failures are a non-Kustomization release template or a component value colliding with an existing substitute key. Test in Task 9: `fails a substitute-key collision before any write`.

---

### Task 1: App/component compatibility check

**Files:**
- Create: `scripts/check-app-components.sh`, `scripts/test-check-app-components.sh`
- Modify: `shell.nix` (add `pkgs.yq-go`)
- Modify: `.github/workflows/validate-apps.yaml`:
  - add `'components/**'` to `on.pull_request.paths`;
  - add a job `app-components` running `nix-shell shell.nix --run 'bash scripts/check-app-components.sh'`, with checkout and install-nix steps copied from the `validate` job.

**Interfaces:**
- Produces: `bash scripts/check-app-components.sh [<app>...]`.
  - It needs `yq` v4 and `kustomize`.
  - With no arguments, it checks every `apps/*/metadata.yaml` that has `.spec.components`.
  - It always validates every `components/*/component.yaml`.
  - It exits 0 when everything is OK. Otherwise it exits 1 after printing every `FAIL <scope>: <reason>` line to stderr, where scope is `<component>` or `<app>/<component>`.
- Rules it enforces. Later tasks rely on these exact rules.
  - **Descriptor:**
    - `.kind == "ComponentDefinition"` and `.metadata.name` equals the directory name;
    - `.spec.version` is non-empty, and `.spec.kind` is `patch` or `resource`;
    - `kustomization.yaml` has `kind: Component`;
    - if it has `images:`, at least one `newTag` equals `.spec.version`;
    - every value has `from` set to `install` or `app`, and a name outside the reserved list;
    - every `from: install` value has a `pattern` that starts with `^` and ends with `$`;
    - every `${…}` in the component's YAML files has a `:=` default.
  - **Pair:**
    - every key in the app entry's `values` is declared by the component;
    - every `from: app` value is supplied.
  - **Build:** copy `apps/<app>` to a temp dir, copy `components/<c>` to `<tmp>/<app>/shared-components/<c>`, then run `yq -i '.components += ["../../shared-components/<c>"]'` on `overlays/librepod/kustomization.yaml` and `kustomize build` both the baseline and the result.
    - For `patch`, the baseline has exactly one Deployment with the target annotation, and it does not carry `kustomize.toolkit.fluxcd.io/substitute: disabled`. In the result, that Deployment has a container or initContainer named `<c>`.
    - For `resource`, the result has more documents than the baseline.

- [ ] **Step 1: Write `scripts/test-check-app-components.sh`.** Use the copy-the-script-into-a-temp-tree pattern from `scripts/test-generate-catalog.sh`. Fixtures:
  - **`components/side`** (patch, version `v1.0.0`, `images: [{name: busybox, newTag: v1.0.0}]`). It adds a container `side` with image `busybox`.
  - **`components/res`** (resource). It has a ConfigMap `res` with `data.host: ${RES_HOST:=x}`, plus the values `RES_HOST` (`from: app`) and `RES_NAME` (`from: install`, `pattern: "^[a-z]+$"`, `default: "{app}"`).
  - **`apps/demo`:**
    - Deployment `demo`, annotated.
    - Deployment `sibling`, not annotated.
    - `spec.components: [{name: side}, {name: res, values: {RES_HOST: h}}]`.
  - **`apps/bare`:** one Deployment without the annotation, and `spec.components: [{name: side}]`.

  Cases, each a function that calls `fail` on a wrong outcome:
  - `demo_passes`: running on `demo` exits 0.
  - `sibling_untouched`: run the same build by hand and assert that `yq 'select(.metadata.name=="sibling") | .spec.template.spec.containers[].name'` lacks `side`.
  - `missing_target_fails`: `bare` exits 1, and stderr contains `FAIL bare/side`.
  - `missing_app_value_fails`: delete `RES_HOST` from demo's values; the run exits 1 with `RES_HOST`.
  - `undeclared_value_fails`: add `values: {NOPE: x}` to `side`; the run exits 1 with `NOPE`.
  - `unanchored_pattern_fails`: set the `res` pattern to `[a-z]+`; the run exits 1 with `pattern`.
  - `reserved_name_fails`: rename `RES_NAME` to `INSTANCE_NAME`; the run exits 1.
  - `var_without_default_fails`: change the `res` ConfigMap to `${RES_HOST}`; the run exits 1 with `default`.
  - `substitute_disabled_fails`: annotate `demo` with `kustomize.toolkit.fluxcd.io/substitute: disabled`; the run exits 1.
  - `two_targets_fail`: annotate `sibling` too; the run exits 1.
- [ ] **Step 2: Run it and watch it fail.** `nix-shell shell.nix --run 'bash scripts/test-check-app-components.sh'` should fail because the script is missing.
- [ ] **Step 3: Implement `scripts/check-app-components.sh`** to the rules above. Collect all failures before exiting, so one CI run reports every broken pair.
- [ ] **Step 4: Run the test again.** Expected: `PASS` (exit 0). Then run `nix-shell shell.nix --run 'bash scripts/check-app-components.sh'` on the real repo. Expected: exit 0, because no app lists components yet.
- [ ] **Step 5: Commit.** `git commit -m "ci: check app/shared-component compatibility"`, including `shell.nix` and `validate-apps.yaml`.

### Task 2: gluetun and sing-box components, firefly-iii-telegram-bot opt-in

**Files:**
- Create: `components/gluetun/{component.yaml,kustomization.yaml,patch-deployment.yaml,externalsecret.yaml}`
- Create: `components/sing-box/{component.yaml,kustomization.yaml,patch-deployment.yaml,externalsecret.yaml}`
- Modify: `apps/firefly-iii-telegram-bot/base/deployment.yaml` (add the target annotation to `metadata.annotations`)
- Modify: `apps/firefly-iii-telegram-bot/metadata.yaml` (add `spec.components: [{name: gluetun}, {name: sing-box}]`, placed after `settings:`)

**Interfaces:**
- Consumes: the Task 1 check script.
- Produces: descriptors read by Task 6. Both have `group: network` and `kind: patch`, and no `values`.
  - gluetun `settings`: `[{name: WG_CONFIG, label: "WireGuard config", type: text, sensitive: true, required: true}]`.
  - sing-box `settings`: `[{name: CONFIG, label: "sing-box config (JSON)", type: text, sensitive: true, required: true}]`.

Both are native sidecars, meaning an `initContainers` entry with `restartPolicy: Always`. Both use a container `securityContext` with `runAsUser: 0`, `runAsNonRoot: false` and `capabilities.add: [NET_ADMIN]`, plus `/dev/net/tun` mounted from `hostPath` `CharDevice`, the same as collie's existing patch. The `version` is the image tag pinned at build time, with a `# renovate: datasource=docker depName=<image>` line directly above it.

- **gluetun** (`qmcgaw/gluetun`). Follow the spec section "`gluetun`". Builder decisions:
  - Mount Secret `gluetun-settings` using `items: [{key: WG_CONFIG, path: wg0.conf}]` at the directory gluetun's custom WireGuard provider reads. Confirm the path and env names in gluetun's docs for the pinned version.
  - gluetun must leave the pod's DNS alone, so the app still resolves cluster names. Set gluetun's "keep the pod nameserver / no built-in DNS server" option for the pinned version.
  - Use an `exec` startupProbe running `/gluetun-entrypoint healthcheck`, with `periodSeconds: 5` and `failureThreshold: 60`.
- **sing-box** (`ghcr.io/sagernet/sing-box`). Mount Secret `sing-box-settings` using `items: [{key: CONFIG, path: config.json}]` at `/etc/sing-box`. Set `args: ["run", "-c", "/etc/sing-box/config.json"]`, and add no probe.

- [ ] **Step 1: Run the check and watch it fail.** Add the firefly `spec.components` entry first, then run `nix-shell shell.nix --run 'bash scripts/check-app-components.sh firefly-iii-telegram-bot'`. Expected: FAIL, unknown component `gluetun`.
- [ ] **Step 2: Write both component directories and the firefly annotation.**
- [ ] **Step 3: Run the check again.** Expected: exit 0. Then run `kustomize build` on the gluetun result the check produced (use a temp copy, the same as the check does) and confirm:
  - `.spec.template.spec.initContainers[] | select(.name=="gluetun") | .restartPolicy == "Always"`;
  - the env has `FIREWALL_OUTBOUND_SUBNETS: 10.42.0.0/16,10.43.0.0/16`.
- [ ] **Step 4: Commit.** `git commit -m "feat(components): add gluetun and sing-box VPN egress components"`

### Task 3: tailscale component, collie and remnawave migration

**Files:**
- Create: `components/tailscale/{component.yaml,kustomization.yaml,patch-deployment.yaml,externalsecret.yaml,pvc.yaml,tailscale.env}`
- Delete: `apps/collie/components/tailscale/`, `apps/remnawave/components/tailscale/`
- Modify:
  - `apps/collie/overlays/librepod/kustomization.yaml`: drop `components:` and the `tailscale/tailscale` `images:` entry.
  - `apps/collie/base/deployment.yaml`:
    - add the target annotation;
    - add `serviceAccountName: default`, with the existing explanatory comment moved from the old patch;
    - drop the `state` volume mount on the tailscale path if nothing else uses it.
  - `apps/collie/metadata.yaml`:
    - remove the `TS_AUTHKEY`, `TS_EXTRA_ARGS` and `TS_HOSTNAME` settings;
    - add `spec.components: [{name: tailscale, values: {TS_HOSTNAME: collie-lead}}]`.
  - `apps/collie/README.md`: settings table and migration note, per the spec's migration table.
  - `apps/remnawave/overlays/librepod/kustomization.yaml`: delete the commented tailscale block.
  - `apps/remnawave/base/deployment.yaml`: add the annotation.
  - `apps/remnawave/metadata.yaml`: add `spec.components: [{name: tailscale}]`.

**Interfaces:**
- Consumes: the Task 1 check script.
- Produces: the tailscale descriptor.
  - `group: network`, `kind: patch`, `version` set to the `tailscale/tailscale` tag (`v1.104.2` unless Renovate has moved it).
  - `settings: [TS_AUTHKEY (sensitive, required), TS_EXTRA_ARGS]`.
  - `values: [{name: TS_HOSTNAME, from: install, label: "Tailnet hostname", default: "{app}", pattern: "^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$"}]`.

Follow the spec section "`tailscale`" exactly:
- ConfigMap generator `tailscale-env` from `tailscale.env`. It sets `TS_HOSTNAME=${TS_HOSTNAME:=app}`, and the patch uses it through `envFrom`.
- Secret `tailscale-settings`, used through `secretKeyRef`, with `optional: true` for `TS_EXTRA_ARGS`.
- PVC `tailscale-state`: 1Gi, RWO, `storageClassName: nfs-client`, mounted at `/var/lib/tailscale`.
- DNS `searches`, in this order: `ts.${BASE_DOMAIN:=libre.pod}`, `${INSTANCE_NAME:=app}.svc.cluster.local`, `svc.cluster.local`, `cluster.local`.
- No ServiceAccount, Role or `serviceAccountName`.

- [ ] **Step 1: Watch the check fail.** Make the metadata edits first, then run `bash scripts/check-app-components.sh collie remnawave` inside nix-shell. Expected: FAIL, unknown component `tailscale`.
- [ ] **Step 2: Write `components/tailscale/`, delete both app copies, and finish the app edits.**
- [ ] **Step 3: Run the check again.** Expected: exit 0. Then build remnawave with the component and assert:
  - `.spec.template.spec.dnsConfig.searches` contains `svc.cluster.local`;
  - no `kind: Role` or `kind: ServiceAccount` named `*tailscale*` is rendered;
  - `kustomize build apps/collie/overlays/librepod` succeeds without the component.
- [ ] **Step 4: Commit.** `git commit -m "feat(components): extract tailscale into a shared component"`

### Task 4: frp-expose component, headscale migration, immich opt-in

**Files:**
- Create: `components/frp-expose/{component.yaml,kustomization.yaml,upstream.yaml}`
- Delete: `apps/headscale/components/frp-upstreams/`. Move its DERP/STUN explanation comment into `apps/headscale/README.md` (create the file if absent), because it is still true.
- Modify:
  - `apps/headscale/overlays/librepod/kustomization.yaml`: drop `../../components/frp-upstreams`.
  - Replace `https://headscale.${FRP_DOMAIN...}` with `https://${FRP_EXPOSE_SUBDOMAIN:=headscale}.${FRP_DOMAIN...}` in:
    - `apps/headscale/base/config.yaml` (`server_url`);
    - `apps/headscale/components/headplane/config.yaml` (`public_url`);
    - `apps/headscale/overlays/librepod/ssoclient.yaml` (redirect URI).
  - `apps/headscale/metadata.yaml`: add `spec.components: [{name: frp-expose, values: {FRP_EXPOSE_HOST: headscale.headscale.svc.cluster.local, FRP_EXPOSE_PORT: "80"}}]`. Append one sentence to its `description`: without the frp-expose component, clients cannot reach headscale, because its URLs point at the relay.
  - `apps/immich/metadata.yaml`: add `spec.components: [{name: frp-expose, values: {FRP_EXPOSE_HOST: immich-server.immich.svc.cluster.local, FRP_EXPOSE_PORT: "2283"}}]`.

**Interfaces:**
- Consumes: the Task 1 check script.
- Produces: the frp-expose descriptor.
  - `kind: resource`, no `group`, `version: "1.0.0"` (hand-bumped, no renovate line).
  - No `settings`.
  - `values`:
    - `FRP_EXPOSE_HOST` and `FRP_EXPOSE_PORT`, both `from: app`;
    - `FRP_EXPOSE_SUBDOMAIN`, `from: install`, `label: "Public subdomain"`, `default: "{app}"`, with the DNS-label pattern from Task 3.

`upstream.yaml` is the spec's Upstream verbatim.

- [ ] **Step 1: Watch the check fail.** Make the metadata edits, then run `bash scripts/check-app-components.sh headscale immich`. Expected: FAIL, unknown component.
- [ ] **Step 2: Write `components/frp-expose/` and finish the headscale edits.**
- [ ] **Step 3: Run the check again.** Expected: exit 0. Then run `kustomize build apps/headscale/overlays/librepod` and grep it: no `headscale.${FRP_DOMAIN` literal remains, and `${FRP_EXPOSE_SUBDOMAIN:=headscale}` appears three times.
- [ ] **Step 4: Commit.** `git commit -m "feat(components): add frp-expose; headscale uses it instead of its own upstream"`

### Task 5: Component publishing

**Files:**
- Create: `scripts/publish-components.sh`, `scripts/test-publish-components.sh`, `.github/workflows/publish-components.yaml`
- Modify: `renovate.json5`:
  - add `"/components/.*/kustomization\\.ya?ml/"` to `kustomize.managerFilePatterns`;
  - add `"/components/.*/component\\.yaml/"` to the regex custom manager's `managerFilePatterns`;
  - change the disable rule to `["**/*", "!apps/**", "!components/**"]`;
  - extend the group rule's `matchFileNames` with `"components/*/**"`.

**Interfaces:**
- Produces: `bash scripts/publish-components.sh [--push] [--pr <n>] [--base <rev>] [all | <name>...]`.
  - **Which components:**
    - with names, those (an unknown name is exit 2);
    - with `all`, every `components/*/`;
    - with neither, the directories changed in `git diff --name-only <base> HEAD -- components/`. `--base` defaults to `HEAD~1`.
  - **Version:** read like `publish-apps.yaml` does: `grep '^  version:'`, strip any trailing comment and the quotes. An empty version is exit 1.
  - **Tags:** `pr-<n>` with `--pr`; otherwise `<version>` and `latest`.
  - **Without `--push`:** print one line per push, `DRY RUN: flux push artifact oci://${OCI_REPO}/<name>:<tag> --path=./components/<name>`. `OCI_REPO` defaults to `ghcr.io/librepod/marketplace/components`.
  - **With `--push`:**
    - push with the same `--source`, `--revision` and `--ignore-paths` arguments as `publish-apps.yaml`, using `--output json`;
    - sign each digest keyless for `--pr`;
    - otherwise sign with the same key env var and password env var that `publish-apps.yaml` uses.
- Workflow:
  - triggers on `components/**` for push to master and PRs, plus `workflow_dispatch` with an input `components` (space-separated names or `all`);
  - permissions `packages: write`, `contents: read`, `id-token: write`;
  - setup actions identical to `publish-apps.yaml`'s publish job;
  - one step with env `PR_NUMBER`, `BASE` (`github.event.pull_request.base.sha || github.event.before`), `COMPONENTS` and the two cosign secrets;
  - `run: bash scripts/publish-components.sh --push ${PR_NUMBER:+--pr "$PR_NUMBER"} --base "$BASE" $COMPONENTS`.

- [ ] **Step 1: Write the test.** It builds a temp git repo with `components/a` (version `"v1"`) and `components/b` (version `"2.0.0"  # comment`), then makes a second commit touching only `a`. Cases:
  - `changed_only`: the default run prints `oci://…/a:v1` and `oci://…/a:latest`, and nothing for `b`.
  - `pr_tag`: `--pr 7 a` prints only `a:pr-7`.
  - `all_strips_comment`: `all` prints `b:2.0.0`.
  - `unknown_name`: `nope` exits 2.
  - `empty_version`: blank out `a`'s version; running on `a` exits 1.
  - `no_push_by_default`: put a fake `flux` that writes a marker file on PATH. The default run leaves no marker.
- [ ] **Step 2: Run `bash scripts/test-publish-components.sh`.** Expected: FAIL, script missing.
- [ ] **Step 3: Implement the script and the workflow.** Then edit `renovate.json5`.
- [ ] **Step 4: Run the test again.** Expected: `PASS`. Then run `npx --yes --package renovate -- renovate-config-validator renovate.json5`. Expected: `Config validated successfully`.
- [ ] **Step 5: Commit.** `git commit -m "ci: publish shared components as signed OCI artifacts"`

### Task 6: Catalog generation

**Files:**
- Modify: `scripts/generate-catalog.sh`, `scripts/test-generate-catalog.sh`
- Modify: `.github/workflows/publish-catalog.yaml`:
  - add `'components/*/component.yaml'` to `on.push.paths`;
  - add `Publish Component Artifacts` to `on.workflow_run.workflows`, so the catalog republishes after a component artifact exists.

**Interfaces:**
- Produces the `catalog.yaml` shape that Task 7 parses:
  - **Per app:** `components:` holds the app's `spec.components` block verbatim, extracted and indented exactly like `settings:` (8 spaces).
  - **Top level:** after the `apps:` list, `components:` maps each `<name>` to the `spec:` block of `components/<name>/component.yaml`, re-indented by 2 spaces. Emit it only when at least one `components/*/component.yaml` exists.
  - **Failure:** generation fails with `ERROR: <app> lists unknown component "<name>"` when an app's `- name:` has no `components/<name>/component.yaml`. Value checks stay in Task 1's script, which gates PRs before this runs on master.

- [ ] **Step 1: Extend the test fixtures and add cases.** Add a fixture `components/demo-net/component.yaml` (version `"v1.0.0"`, `group: network`, one setting, one `from: install` value with `default: "{app}"`). Give the demo app `spec.components: [{name: demo-net, values: {DEMO_HOST: demo.svc}}]`. Parse the output with js-yaml and assert:
  - `catalog.components['demo-net'].version === 'v1.0.0'`;
  - `catalog.components['demo-net'].values[0].default === '{app}'`;
  - `app.components` deep-equals `[{name: 'demo-net', values: {DEMO_HOST: 'demo.svc'}}]`;
  - `app.settings` is unchanged.

  Add a second run whose app lists `ghost`. It must exit non-zero, and stderr must contain `unknown component "ghost"`.
- [ ] **Step 2: Run `bash scripts/test-generate-catalog.sh`.** Expected: FAIL on `catalog.components` undefined.
- [ ] **Step 3: Implement it in `generate-catalog.sh`.** Reuse the settings-block awk/sed. Iterate `components/*/component.yaml` with the same `LC_ALL=C` glob order.
- [ ] **Step 4: Run the test again.** Expected: `PASS`. Run the real `bash scripts/generate-catalog.sh` once to confirm the five opt-in apps produce no error. The root `catalog.yaml` it writes is gitignored, so there is nothing to revert.
- [ ] **Step 5: Commit.** `git commit -m "feat(catalog): emit shared components and per-app opt-ins"`

### Task 7: Shared types and catalog join (server)

**Files:**
- Modify: `ui/packages/shared/src/types.ts`, `ui/packages/server/src/catalog/catalog.types.ts`, `ui/packages/server/src/catalog/catalog.service.ts`
- Create: `ui/packages/server/src/catalog/components.ts`, `ui/packages/server/src/catalog/components.spec.ts`
- Modify: `ui/packages/server/test/fixtures/catalog.fixture.yaml` (add one component, and one app referencing it), `ui/packages/server/src/catalog/catalog.service.spec.ts`

**Interfaces:**
- Produces, in `@librepod/shared`:

```ts
export type AppSettingType = 'string' | 'boolean' | 'number' | 'text';  // text = multi-line
export interface ComponentValueDef {
  name: string; from: 'install' | 'app';
  label?: string; description?: string; default?: string; pattern?: string;
}
export interface ComponentDefinition {
  displayName: string; description: string; version: string;
  group?: string; kind: 'patch' | 'resource';
  settings?: AppSettingItem[]; values?: ComponentValueDef[];
}
/** A component as offered for one app: `values[].default` is final ({app} filled, app values applied). */
export interface AppComponent extends ComponentDefinition { name: string; values: ComponentValueDef[] }
export interface ComponentRequest { name: string; settings?: Record<string, string>; values?: Record<string, string> }
// CatalogApp gains:      components?: AppComponent[]
// InstallRequest gains:  components?: ComponentRequest[]
```

- In `catalog.types.ts`:
  - `CatalogApp` gains `components?: AppComponent[]`;
  - `CatalogFile` gains `components?: Record<string, ComponentDefinition>`;
  - raw entries are `AppComponentRef { name: string; values?: Record<string, string | number | boolean> }`.
- Signature: `joinComponents(appName: string, refs: AppComponentRef[] | undefined, defs: Record<string, ComponentDefinition> | undefined, warn: (msg: string) => void): AppComponent[]`.
  - For a `from: app` def, `default = String(ref.values[name])`.
  - For a `from: install` def, `default = String(ref.values[name] ?? def.default).replaceAll('{app}', appName)`.
  - A ref naming an unknown component, or missing a `from: app` value, is dropped with `warn`.
- `CatalogService.loadCatalog` replaces each app's raw `components` with the joined list. It omits the field when the list is empty.

- [ ] **Step 1: Write `components.spec.ts`:**
  - `fills {app} into install defaults`: frp-expose on `immich` gives subdomain default `immich`.
  - `lets the app override an install default`: collie with `TS_HOSTNAME: collie-lead` gives `collie-lead`.
  - `fills from:app values`: `FRP_EXPOSE_PORT: 2283` (a number) gives `'2283'`.
  - `drops unknown components with a warning`.
  - `drops a component missing a from:app value with a warning`.

  In `catalog.service.spec.ts`, add `joins components from the catalog file`: `findOne('<fixture app>').components[0].name` is the fixture component.
- [ ] **Step 2: Run the tests.** `npm test --workspace=packages/server -- src/catalog/` → FAIL.
- [ ] **Step 3: Implement `joinComponents`, the type additions and the `loadCatalog` call.**
- [ ] **Step 4: Run the tests again.** Expected: PASS. Then run the whole suite with `npm test --workspace=packages/server` (expected: PASS) and `npm run build --workspace=packages/server` (expected: exit 0).
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): load shared components into catalog apps"`

### Task 8: Install validation — `resolveComponents`

**Files:**
- Create: `ui/packages/server/src/installed/install-components.ts`, `ui/packages/server/src/installed/install-components.spec.ts`

**Interfaces:**
- Consumes:
  - `AppComponent` and `ComponentRequest` (Task 7);
  - `resolveSettings` and `isPlainObject` from `./install-settings`.
- Produces:

```ts
export const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
export interface ResolvedComponent {
  name: string; version: string;
  hasSettings: boolean;                 // def declares settings → its OpenBao entry and ExternalSecret exist
  settings: Record<string, string>;     // → OpenBao apps/<app>/<name>
  values: Record<string, string>;       // install + app values → postBuild.substitute
}
export function resolveComponents(app: CatalogApp, body: unknown):
  | { ok: true; components: ResolvedComponent[] }
  | { ok: false; errors: FieldError[] };
```

- Field error names:
  - `components` for the shape or group;
  - `components.<name>` for an unknown, duplicate or malformed entry;
  - `components.<name>.<FIELD>` for a setting or value.
- Component settings run through `resolveSettings({ items: def.settings ?? [] }, { settings: entry.settings ?? {} }, null)`. Its error names are prefixed with `components.<name>.`, except `settings`, which maps to `components.<name>`.
- Values:
  - **`from: install`:** `entry.values?.[name] ?? def.default`. It must be non-empty and match both `new RegExp(def.pattern)` and `SAFE_VALUE`.
  - **`from: app`:** the def's `default`. Giving one in the request is an error (`Set by the app`).
  - Unknown value keys are errors.

- [ ] **Step 1: Write the tests.** Build the fixture `AppComponent`s inline: tailscale (network), gluetun (network) and frp-expose. Cases:
  - `returns no components when the body has none`, covering `{}`, `undefined` and `components: []`;
  - `rejects a non-list` → `components`;
  - `rejects an unknown component` → `components.nope`;
  - `rejects a duplicate`;
  - `rejects two network components` → `components`, with a message naming the group;
  - `requires required settings` → `components.tailscale.TS_AUTHKEY`;
  - `uses the install default` → frp-expose on immich gives `FRP_EXPOSE_SUBDOMAIN: 'immich'`, and the `from: app` values are included;
  - `rejects a value failing the pattern`;
  - `rejects install values outside SAFE_VALUE even when the pattern allows them`: the pattern is `^.*$`, and the values `a b`, `${X}` and `a:b` each give an error;
  - `rejects overriding a from:app value`;
  - `rejects an unknown value key`.
- [ ] **Step 2: Run them.** `npm test --workspace=packages/server -- src/installed/install-components.spec.ts` → FAIL.
- [ ] **Step 3: Implement `resolveComponents`.**
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): validate component selections on install"`

### Task 9: Install rendering and wiring

**Files:**
- Create: `ui/packages/server/src/installed/component-files.ts`, `ui/packages/server/src/installed/component-files.spec.ts`
- Modify: `ui/packages/server/src/installed/installed.service.ts`, `ui/packages/server/src/installed/installed.service.spec.ts`
- Modify: `ui/CLAUDE.md`. In "Install flow", add one step describing the component branch (validate → render → OpenBao `apps/<app>/<c>` → one commit).

**Interfaces:**
- Consumes: `ResolvedComponent` and `resolveComponents` (Task 8).
- Produces:

```ts
export const COMPONENTS_OCI_REPO = 'oci://ghcr.io/librepod/marketplace/components';
/** Throws Error on a non-Kustomization release or a substitute-key collision. */
export function renderComponentFiles(
  appName: string, components: ResolvedComponent[],
  rendered: { release: string; kustomization: string },
): Record<string, string>;   // keys: components.yaml, generator.yaml, release.yaml, kustomization.yaml
```

  The output shapes are exactly the spec's "Install layer" YAML. Build them as objects and `yaml.dump(…, { lineWidth: -1 })` them, joining multiple documents with `---\n`. Components are sorted by name everywhere.
- `install()` order:
  1. app checks, as today;
  2. app settings `resolveForWrite` (only when `app.settings`);
  3. `resolveComponents`, where errors become `BadRequestException({ message: 'Some settings need attention', errors })`;
  4. `vars`, including `DEVICE_IP` and the legacy generated secrets. Secret generation moves up here; it is pure.
  5. render all files, including `renderComponentFiles` when components were selected. Its `Error` becomes an `InternalServerErrorException`.
  6. OpenBao app write;
  7. `openBao.writeAppSettings(\`${appName}/${c.name}\`, c.settings)` for each `c` with `hasSettings`. It goes through `throwSettingsStoreError` and writes even an empty map, so the ExternalSecret finds its entry.
  8. `repo.writeApp`.

  Steps 1–5 do no writes.

- [ ] **Step 1: Write `component-files.spec.ts`**, asserting parsed (`yaml.loadAll`) structure rather than golden text:
  - `renders one pinned, verified OCIRepository per component`:
    - name `marketplace-immich-frp-expose`;
    - `spec.ref.tag` is `'1.0.0'`;
    - `spec.verify.secretRef.name` is `'cosign-pub'`;
    - labels `marketplace.io/app` and `marketplace.io/component`.
  - `renders the generator`:
    - `spec.sources` aliases are `['app', 'frp-expose']`;
    - the `artifacts[0].originRevision` is `'@app'`;
    - the copy `to` values are `['@artifact/', '@artifact/shared-components/frp-expose/']`.
  - `patches the release`:
    - `sourceRef` is `{ kind: 'ExternalArtifact', name: 'marketplace-immich' }`;
    - `components` is `['../../shared-components/frp-expose']`;
    - `postBuild.substitute` keeps its existing keys and adds `INSTANCE_NAME: 'immich'` plus the three values.
  - `appends the new files to kustomization resources`.
  - `sorts two components by name`.
  - `throws on a non-Kustomization release`.
  - `throws on a substitute-key collision`.
- [ ] **Step 2: Add to `installed.service.spec.ts`**, in a `describe('install() with components')` that uses an app fixture with `components`:
  - `writes component settings to apps/<app>/<component> and never into apps/<app>`. The `writeAppSettings` calls are `['<app>', appValues]` and `['<app>/tailscale', { TS_AUTHKEY: 'k' }]`, and no app call's map contains `TS_AUTHKEY`.
  - `commits generator.yaml and components.yaml` in the one `writeApp` call.
  - `keeps plain installs byte-identical`: `components` absent and `[]` both give the same `writeApp` files as today's test expects, with no `generator.yaml`.
  - `fails a substitute-key collision before any write`: a 500, with neither `writeAppSettings` nor `writeApp` called.
  - `returns 400 for an invalid selection before any write`.
- [ ] **Step 3: Run the tests.** `npm test --workspace=packages/server -- src/installed/` → FAIL.
- [ ] **Step 4: Implement `renderComponentFiles` and restructure `install()`.**
- [ ] **Step 5: Run the tests again.** `npm test --workspace=packages/server` → PASS, and `npm run build --workspace=packages/server` → exit 0.
- [ ] **Step 6: Commit.** `git commit -m "feat(ui): compose selected components into the install"`

### Task 10: Install dialog

**Files:**
- Modify: `ui/packages/client/src/components/InstallDialog.tsx`, `ui/packages/client/src/components/InstallDialog.test.tsx`
- Modify: `ui/packages/client/src/hooks/useAppSettings.ts`
- Modify: `ui/packages/client/src/pages/AppDetailPage.tsx`, `ui/packages/client/src/pages/AppDetailPage.test.tsx`

**Interfaces:**
- Consumes: `AppComponent`, `ComponentRequest` and `InstallRequest.components` (Task 7), and the field error names from Task 8.
- Produces:
  - `export function hasComponents(app?: CatalogApp): boolean`;
  - `useAppSettings(appName: string, enabled = true)`, which passes `enabled` to `useQuery`.
- Behaviour:
  - **AppDetailPage:**
    - the install button opens the dialog when `hasInstallQuestions(data.settings) || hasComponents(data)`;
    - the Settings (edit) button keeps the condition `hasInstallQuestions(data.settings)`.
  - **`SettingsBody`:** when `!app.settings`, it skips the fetch and uses `{ settings: {}, custom: [] }`.
  - **Components section:** a `<fieldset>` with legend "Components". It renders in `mode === "install"` when `hasComponents(app)`.
    - Each `group` gets a radio group: "None" plus one radio per member.
    - Ungrouped components get a checkbox each.
    - The label is `displayName` and the hint is `description`.
    - Selecting a component reveals its `settings` items and its `from: install` values through the existing `QuestionField`. Values become items with `required: true` and the default prefilled. Field ids are namespaced as `setting-<component>-<NAME>`.
    - Errors named `components.<c>.<NAME>` render at that field. `components` and `components.<c>` go in the top alert.
  - **Request:** `components: [{ name, settings, values }]` for selected components only, and omitted when none are selected.
  - **`text` type:** renders a `<textarea rows={6}>` with the same aria wiring. When `sensitive`, it is masked with the CSS `-webkit-text-security: disc` plus the existing Eye/EyeOff toggle. Comment in code: `shortcut: browsers without -webkit-text-security show it unmasked, upgrade if that matters`.

- [ ] **Step 1: Write the tests:**
  - **InstallDialog.test:**
    - `renders a radio group for network components and a checkbox for frp-expose`;
    - `reveals a component's fields only when selected`;
    - `sends selected components with their settings and values`;
    - `prefills install values with the catalog default`;
    - `shows components.<c>.<NAME> errors at the field`;
    - `renders text settings as a textarea`;
    - `does not show components in edit mode`.
  - **AppDetailPage.test:** `opens the dialog for a settings-less app with components without fetching settings`. Assert no fetch to `/settings`, and that the POST body has `components`.
- [ ] **Step 2: Run the tests.** `npm run test --workspace=packages/client -- --run src/components/InstallDialog.test.tsx src/pages/AppDetailPage.test.tsx` → FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run the tests again.** Expected: PASS. Then run `npm run test:client` (expected: PASS) and `npm run build:client` (expected: exit 0).
- [ ] **Step 5: Commit.** `git commit -m "feat(ui): pick shared components in the install dialog"`

### Task 11: Platform and authoring docs

**Files:**
- Modify: `clusters/librepod-k3d/bootstrap/flux-instance.yaml`. Under `instance:`, add `components: [source-controller, kustomize-controller, helm-controller, notification-controller, source-watcher]`.
- Create: `components/README.md`, at most about 40 lines:
  - what a component is;
  - the author rules from the spec's "Repo layer", plus the container-name rule;
  - how an app opts in;
  - how to run `scripts/check-app-components.sh`.
- Modify: `.claude/skills/librepod-app/SKILL.md`. Add a short "Shared components" section: the annotation, `spec.components`, the check script, and "never vendor a copy into the app".

- [ ] **Step 1: Validate the k3d values.** Render them with `helm template flux-instance oci://ghcr.io/controlplaneio-fluxcd/charts/flux-instance --version 0.57.0 -f <(yq '.spec.valuesContent' clusters/librepod-k3d/bootstrap/flux-instance.yaml)`. Expected: the FluxInstance `spec.components` lists `source-watcher`.
- [ ] **Step 2: Write the docs.**
- [ ] **Step 3: Commit.** `git commit -m "chore: enable source-watcher on k3d and document shared components"`

---

## Handoff checklist (maintainer, or with their go-ahead)

These steps need a person or a live cluster. They are not agent tasks. The spec's "Rollout order → Plan boundary" section is the source.

- [ ] **Dev smoke test, before Task 9/10 merge.**
  1. Hand-push one component artifact.
  2. Hand-write a generator plus a Kustomization with `spec.components` for one installed app.
  3. Confirm that it reconciles and that the nested ExternalSecret key `apps/<app>/<component>` resolves.
- [ ] **E2E credentials:** a WireGuard config, a sing-box config, a headscale pre-auth key, and a free relay subdomain.
- [ ] **After the first master publish:** confirm the `marketplace/components/*` GHCR packages are public.
- [ ] **Dev E2E:** follow spec Testing item 6, plus remnawave reaching postgres with the tailscale sidecar up.
- [ ] **Production, before the marketplace-ui release:**
  - confirm its Flux is 2.7.2 or later;
  - add `source-watcher` to its FluxInstance.
- [ ] **Release:** release marketplace-ui (`scripts/release-marketplace-ui.sh`) and bump its pins.
- [ ] **Reinstalls:**
  - collie: delete the old `collie-lead` node first;
  - headscale: subdomain `headscale`;
  - remnawave, if wanted.
