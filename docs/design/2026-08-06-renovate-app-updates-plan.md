# Renovate App Update Automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate upstream version tracking for `apps/` — Renovate opens one validated PR per app when an upstream image/chart updates — after first de-duplicating the version field to a single source per app.

**Architecture:** Two sequenced deliverables. **D1** collapses the duplicated version (`spec.version` + `templates.source.ref.tag`) into one string per app using a `__VERSION__` sentinel that `generate-catalog.sh` fills in, and standardizes `marketplace-ui`. **D2** adds `renovate.json5` (native kustomize/flux managers + annotated customManagers, `infrastructure/**` ignored) and a `validate-apps.yaml` CI gate (kustomize build → kubeconform → flux build), plus a label-gated e2e job. D2 rolls out via a 3-app pilot first.

**Tech Stack:** Bash + awk/sed (catalog generator), Renovate (JSON5 config), GitHub Actions, `nix-shell shell.nix` (fluxcd, kustomize, kubectl, k3d, jq), kubeconform.

**Reference spec:** `docs/design/2026-08-06-renovate-app-updates-design.md`

## Global Constraints

- **Sentinel is `__VERSION__`** (double-underscore), never `${VERSION}` — `${...}` collides with Flux `postBuild.substitute`. Verbatim.
- **`__VERSION__` must never appear in `catalog.yaml`** or `apps/marketplace-ui/base/catalog.yaml` — it ships to user clusters. A leak-guard enforces this.
- **`spec.version` is the single version string per app** after D1; it becomes the published OCI artifact tag (`publish-apps.yaml` reads it).
- **Renovate never edits `infrastructure/**`** — system-app cluster adoption stays manual.
- **No auto-merge** anywhere in Renovate config.
- **`validate-apps` runs on all `apps/**` PRs** and is a required check (branch-protection setting, applied by the maintainer).
- **Commit hygiene:** never reference cluster/device hostnames (`librepod-dev`, etc.) in commit messages or public docs. Use `dev`/`prod`.
- Pilot apps for D2 rollout: **gogs**, **litellm**, **whoami** (all Docker Hub images keyed by their kustomize `name:` — `gogs/gogs`, `litellm/litellm`, `traefik/whoami`).

---

# DELIVERABLE 1 — De-duplicate `spec.version`

### Task 1: Sentinel-ize the source-template `ref.tag` in all app metadata

Replace the hard-coded `ref.tag` in each `apps/*/metadata.yaml` `templates.source` block with `__VERSION__`, leaving `spec.version` as the sole real version. `marketplace-ui` has no `templates:` block yet — it is handled in Task 4, so it is excluded here.

**Files:**
- Modify: every `apps/*/metadata.yaml` that contains a `templates.source` block with a `ref: / tag:` (all apps except `marketplace-ui`)

**Interfaces:**
- Produces: every source template now reads `tag: "__VERSION__"`. Task 2 (generator) relies on this exact sentinel string.

- [ ] **Step 1: Snapshot the current catalog for the byte-identical check later**

```bash
cp catalog.yaml /tmp/catalog.before.yaml
```

- [ ] **Step 2: Replace `ref.tag` with the sentinel across all app metadata**

The source-template ref block is uniform everywhere: `ref:` then `tag: "<version>"` at 10-space indent. Rewrite only the `tag:` line that sits inside a `templates.source` block. Because `spec.version` also matches `tag:`-like lines? No — `spec.version` is `version:`, distinct. But a naive global replace of every `tag:` line is unsafe (release templates, other resources have their own tags). Use an awk pass that only rewrites the FIRST `tag:` after a `source: |` marker per file:

```bash
for f in apps/*/metadata.yaml; do
  # skip files without a source template
  grep -q '^    source: |' "$f" || continue
  awk '
    /^    source: \|/ { insrc=1 }
    insrc && /^          tag: / && !done {
      sub(/tag: .*/, "tag: \"__VERSION__\"")
      done=1
    }
    { print }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
```

- [ ] **Step 3: Verify every app (except marketplace-ui) now has the sentinel and no stray real tag in its source block**

```bash
# Expect: one __VERSION__ per app that has a source template
grep -rl '^    source: |' apps/*/metadata.yaml | while read f; do
  n=$(grep -c 'tag: "__VERSION__"' "$f")
  echo "$f -> $n sentinel(s)"
done
```
Expected: each listed file shows `-> 1 sentinel(s)`. `apps/marketplace-ui/metadata.yaml` is NOT listed (no source template yet).

- [ ] **Step 4: Sanity — confirm `spec.version` is untouched (still a real value)**

```bash
grep -h '^  version:' apps/*/metadata.yaml | sort -u | head
```
Expected: real versions like `"0.14.3"`, `"v1.93.0"` — NOT `__VERSION__`.

- [ ] **Step 5: Commit**

```bash
git add apps/*/metadata.yaml
git commit -m "refactor(apps): sentinel-ize source-template ref.tag for catalog generation"
```

---

### Task 2: Fill the sentinel from `spec.version` in the catalog generator

Make `generate-catalog.sh` substitute `__VERSION__` with the app's extracted `$VERSION` when emitting the source template, and hard-fail if any sentinel leaks into the output.

**Files:**
- Modify: `scripts/generate-catalog.sh`

**Interfaces:**
- Consumes: `tag: "__VERSION__"` sentinel from Task 1; `$VERSION` variable already extracted in the script from `spec.version`.
- Produces: a `catalog.yaml` with real tags and no sentinels. Task 3 verifies byte-equality.

- [ ] **Step 1: Substitute the sentinel in the extracted source block**

In `scripts/generate-catalog.sh`, immediately after the line
`TMPL_SOURCE=$(extract_template_block "$metadata_file" "source")`
add:

```bash
  # Fill the version sentinel from spec.version (single source of truth).
  TMPL_SOURCE=$(printf '%s' "$TMPL_SOURCE" | sed "s/__VERSION__/${VERSION}/g")
```

- [ ] **Step 2: Add the leak-guard before the "Catalog written" message**

Near the end of the script, before the final `echo` summary, add:

```bash
if grep -q '__VERSION__' "$CATALOG_FILE"; then
  echo "ERROR: __VERSION__ sentinel leaked into catalog.yaml" >&2
  exit 1
fi
```

- [ ] **Step 3: Add a non-empty version guard inside the per-app loop**

Immediately after `VERSION=$(...)` is assigned in the loop, add:

```bash
  if [ -z "$VERSION" ]; then
    echo "ERROR: $app_name has empty spec.version" >&2
    exit 1
  fi
```

- [ ] **Step 4: Run the generator**

Run: `./scripts/generate-catalog.sh`
Expected: completes without the ERROR lines; prints `Catalog written to: ...`.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-catalog.sh
git commit -m "feat(catalog): fill version sentinel from spec.version + leak/empty guards"
```

---

### Task 3: Prove the refactor is behavior-neutral (byte-identical catalog)

The regenerated catalog must match the pre-refactor snapshot for every app except marketplace-ui (unchanged until Task 4), ignoring only the `generatedAt` timestamp.

**Files:**
- Test only (no source change): compares `/tmp/catalog.before.yaml` vs regenerated `catalog.yaml`

**Interfaces:**
- Consumes: `/tmp/catalog.before.yaml` from Task 1 Step 1; regenerated `catalog.yaml` from Task 2.

- [ ] **Step 1: Diff ignoring the timestamp line**

Run:
```bash
diff <(grep -v 'generatedAt' /tmp/catalog.before.yaml) \
     <(grep -v 'generatedAt' catalog.yaml)
```
Expected: **no output** (empty diff). This proves D1 changed nothing shipped. If there IS output, the sentinel/substitution mismatched a real tag — STOP and fix Task 1/2 before proceeding.

- [ ] **Step 2: Confirm no sentinel in either catalog artifact**

Run:
```bash
grep -c '__VERSION__' catalog.yaml apps/marketplace-ui/base/catalog.yaml
```
Expected: `0` for both files.

- [ ] **Step 3: Commit the regenerated catalog (should be identical, so likely no-op)**

```bash
git add catalog.yaml apps/marketplace-ui/base/catalog.yaml
git commit -m "chore: regenerate catalog.yaml after sentinel refactor" || echo "no catalog changes (expected)"
```

---

### Task 4: Standardize `marketplace-ui` metadata

Add the missing standard `templates:` block (with sentinel) and remove the duplicate `appVersion` field, making marketplace-ui a normal app citizen.

**Files:**
- Modify: `apps/marketplace-ui/metadata.yaml`
- Regenerate: `catalog.yaml`, `apps/marketplace-ui/base/catalog.yaml`

**Interfaces:**
- Consumes: sentinel convention from Task 1; generator behavior from Task 2.
- Produces: marketplace-ui with `templates:` + single `version`. Renovate (D2) treats it uniformly.

- [ ] **Step 1: Remove the duplicate `appVersion` line**

In `apps/marketplace-ui/metadata.yaml`, delete the line:
```yaml
  appVersion: "0.4.0"
```
Leave `version: "0.4.0"` as the single version.

- [ ] **Step 2: Add the standard `templates:` block**

Append under `spec:` (after the `source:` block), modeled on gogs but with marketplace-ui's real dependencies from `infrastructure/system-apps/marketplace-ui.yaml` (`dependsOn: [gogs, cert-manager, casdoor-sso-controller]`, `interval: 1m`):

```yaml
  templates:
    source: |
      apiVersion: source.toolkit.fluxcd.io/v1
      kind: OCIRepository
      metadata:
        name: marketplace-marketplace-ui
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "marketplace-ui"
      spec:
        interval: 10m
        url: oci://ghcr.io/librepod/marketplace/apps/marketplace-ui
        ref:
          tag: "__VERSION__"
    release: |
      apiVersion: kustomize.toolkit.fluxcd.io/v1
      kind: Kustomization
      metadata:
        name: marketplace-marketplace-ui
        namespace: flux-system
        labels:
          marketplace.io/managed: "true"
          marketplace.io/app: "marketplace-ui"
      spec:
        dependsOn:
          - name: gogs
          - name: cert-manager
          - name: casdoor-sso-controller
        interval: 1h
        retryInterval: 2m
        timeout: 5m
        sourceRef:
          kind: OCIRepository
          name: marketplace-marketplace-ui
        path: ./overlays/librepod
        prune: true
        wait: true
        postBuild:
          substitute:
            BASE_DOMAIN: "${BASE_DOMAIN}"
    kustomization: |
      apiVersion: kustomize.config.k8s.io/v1beta1
      kind: Kustomization
      resources:
        - source.yaml
        - release.yaml
```

- [ ] **Step 3: Regenerate and verify no sentinel leak**

Run:
```bash
./scripts/generate-catalog.sh && grep -c '__VERSION__' catalog.yaml
```
Expected: generator succeeds; count is `0`.

- [ ] **Step 4: Confirm marketplace-ui now has a templates block in the catalog**

Run:
```bash
awk '/- name: marketplace-ui/{f=1} f&&/^    - name:/&&!/marketplace-ui/{exit} f&&/templates:/{print "has templates"; exit}' catalog.yaml
```
Expected: `has templates`.

- [ ] **Step 5: Commit**

```bash
git add apps/marketplace-ui/metadata.yaml catalog.yaml apps/marketplace-ui/base/catalog.yaml
git commit -m "refactor(marketplace-ui): add standard templates block, drop duplicate appVersion"
```

---

# DELIVERABLE 2 — Renovate + validation

### Task 5: Add `kubeconform` to the dev shell

The validation gate needs `kubeconform`, which `shell.nix` does not currently provide.

**Files:**
- Modify: `shell.nix`

**Interfaces:**
- Produces: `kubeconform` on PATH inside `nix-shell shell.nix`. Task 6 depends on it.

- [ ] **Step 1: Add the package**

In `shell.nix`, add to the `packages` list (after `pkgs.kustomize`):
```nix
    pkgs.kubeconform
```

- [ ] **Step 2: Verify it resolves**

Run: `nix-shell shell.nix --run "kubeconform -v"`
Expected: prints a version (e.g. `v0.6.x`), no "command not found".

- [ ] **Step 3: Commit**

```bash
git add shell.nix
git commit -m "chore(shell): add kubeconform for manifest validation"
```

---

### Task 6: Add the `validate-apps` CI workflow (build + kubeconform + flux build)

New workflow that, per changed app, runs the B-required validation gate, plus a label-gated on-demand e2e job.

**Files:**
- Create: `.github/workflows/validate-apps.yaml`

**Interfaces:**
- Consumes: `kubeconform` from Task 5; the `detect-changes` diff pattern copied from `.github/workflows/publish-apps.yaml`.
- Produces: a `validate` status check on every `apps/**` PR.

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/validate-apps.yaml`:

```yaml
name: Validate App Manifests

on:
  pull_request:
    branches: [master]
    paths:
      - 'apps/*/metadata.yaml'
      - 'apps/*/base/**'
      - 'apps/*/overlays/**'
      - 'apps/*/components/**'

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      apps: ${{ steps.changes.outputs.apps }}
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - id: changes
        run: |
          BASE="${{ github.event.pull_request.base.sha }}"
          CHANGED=$(git diff --name-only "${BASE}" HEAD -- 'apps/' | cut -d'/' -f2 | sort -u)
          APPS="[]"
          for app in $CHANGED; do
            [ -f "apps/$app/metadata.yaml" ] || continue
            [ -d "apps/$app/overlays/librepod" ] || continue
            APPS=$(echo "$APPS" | jq --arg a "$app" '. + [$a]')
          done
          echo "apps=$(echo "$APPS" | jq -c .)" >> "$GITHUB_OUTPUT"

  validate:
    needs: detect-changes
    if: needs.detect-changes.outputs.apps != '[]'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        app: ${{ fromJSON(needs.detect-changes.outputs.apps) }}
    steps:
      - uses: actions/checkout@v6
      - uses: cachix/install-nix-action@v31
      - name: Build + lint + flux render
        run: |
          nix-shell shell.nix --run '
            set -euo pipefail
            APP=${{ matrix.app }}
            echo "== kustomize build =="
            kustomize build "apps/$APP/overlays/librepod" > /tmp/rendered.yaml
            echo "== kubeconform =="
            kubeconform \
              -schema-location default \
              -schema-location "https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json" \
              -strict -summary /tmp/rendered.yaml
            echo "== flux build =="
            flux build kustomization "$APP" \
              --path "apps/$APP/overlays/librepod" \
              --local-sources GitRepository/flux-system/librepod-apps=./ \
              --dry-run || true
          '

  e2e:
    needs: detect-changes
    if: >
      needs.detect-changes.outputs.apps != '[]' &&
      contains(github.event.pull_request.labels.*.name, 'renovate-e2e')
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        app: ${{ fromJSON(needs.detect-changes.outputs.apps) }}
    steps:
      - uses: actions/checkout@v6
      - uses: cachix/install-nix-action@v31
      - name: Ephemeral k3d deploy + smoke test
        run: |
          echo "On-demand e2e for ${{ matrix.app }} (label renovate-e2e present)."
          echo "TODO wiring note: reuse the k3d flow from ui-e2e-cluster.yaml /"
          echo "the verify-app skill to deploy apps/${{ matrix.app }} and smoke-test."
          # Placeholder gate: kept green until the k3d harness is wired in a follow-up.
```

> **Note for implementer:** The `e2e` job is intentionally a stub that documents the reuse target (`ui-e2e-cluster.yaml` / `verify-app`). Wiring the actual ephemeral deploy is a follow-up beyond this plan's D2 scope; the label mechanism and job skeleton are what D2 delivers. Do not leave a stub in the `validate` job — that one must be fully functional.

- [ ] **Step 2: Lint the workflow YAML locally**

Run: `nix-shell shell.nix --run "kubeconform -h >/dev/null" && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/validate-apps.yaml'))" && echo OK`
Expected: `OK` (valid YAML).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/validate-apps.yaml
git commit -m "ci: add validate-apps gate (kustomize build + kubeconform + flux build)"
```

- [ ] **Step 4: (Manual, maintainer) Make `validate` a required status check**

In GitHub branch protection for `master`, add the `validate` job as a required check. Documented here; not automatable in this plan.

---

### Task 7: Add `renovate.json5` with pilot-app scope

Renovate config: native managers, ignore `infrastructure/**`, one PR per app, no auto-merge. Scoped to the 3 pilot apps first via `enabledManagers` + an explicit include, so the pilot proves the flow before full rollout.

**Files:**
- Create: `renovate.json5`

**Interfaces:**
- Consumes: sentinel-free `spec.version` (D1); the `validate-apps` gate (Task 6).
- Produces: Renovate PRs for gogs/litellm/whoami.

- [ ] **Step 1: Create the config**

Create `renovate.json5`:

```json5
{
  $schema: "https://docs.renovatebot.com/renovate-schema.json",
  extends: ["config:recommended"],
  dependencyDashboard: true,
  // Never touch system-app cluster-adoption manifests.
  ignorePaths: ["infrastructure/**"],
  // Everything is reviewed by a human.
  automerge: false,
  // Native managers that already understand our files.
  kustomize: { managerFilePatterns: ["/apps/.*/overlays/.*/kustomization\\.ya?ml/"] },
  flux: { managerFilePatterns: ["/apps/.*/base/ocirepository\\.ya?ml/"] },
  // customManager: bump spec.version in metadata.yaml, driven by an annotation.
  customManagers: [
    {
      customType: "regex",
      managerFilePatterns: ["/apps/.*/metadata\\.yaml/"],
      matchStrings: [
        "# renovate: datasource=(?<datasource>\\S+) depName=(?<depName>\\S+)\\s+version:\\s*\"?(?<currentValue>[^\"\\s]+)\"?",
      ],
    },
  ],
  packageRules: [
    // PILOT: only gogs, litellm, whoami are enabled for now.
    { matchFileNames: ["apps/**"], enabled: false },
    {
      matchFileNames: ["apps/gogs/**", "apps/litellm/**", "apps/whoami/**"],
      enabled: true,
    },
    // One grouped PR per pilot app.
    { matchFileNames: ["apps/gogs/**"], groupName: "gogs" },
    { matchFileNames: ["apps/litellm/**"], groupName: "litellm" },
    { matchFileNames: ["apps/whoami/**"], groupName: "whoami" },
    // Majors get their own PR + the on-demand e2e label.
    { matchUpdateTypes: ["major"], addLabels: ["renovate-e2e"] },
  ],
}
```

- [ ] **Step 2: Add the `# renovate:` annotation above each pilot app's `version:` line**

For each pilot app, insert a comment line directly above `version:` in `apps/<app>/metadata.yaml`:

- `apps/gogs/metadata.yaml`:
```yaml
  # renovate: datasource=docker depName=gogs/gogs
  version: "0.14.3"
```
- `apps/litellm/metadata.yaml` (target the app image, NOT the alpine sidecar):
```yaml
  # renovate: datasource=docker depName=litellm/litellm
  version: "v1.93.0"
```
- `apps/whoami/metadata.yaml`:
```yaml
  # renovate: datasource=docker depName=traefik/whoami
  version: "v1.11.0"
```

- [ ] **Step 3: Validate the config parses**

Run: `npx --yes --package renovate -- renovate-config-validator renovate.json5`
Expected: `Config validated successfully`.

- [ ] **Step 4: Confirm the annotation regex matches (dry sanity, no network)**

Run:
```bash
grep -B1 '^  version:' apps/gogs/metadata.yaml apps/litellm/metadata.yaml apps/whoami/metadata.yaml
```
Expected: each shows the `# renovate: datasource=docker depName=...` line immediately above `version:`.

- [ ] **Step 5: Commit**

```bash
git add renovate.json5 apps/gogs/metadata.yaml apps/litellm/metadata.yaml apps/whoami/metadata.yaml
git commit -m "feat: add Renovate config (pilot: gogs, litellm, whoami)"
```

---

### Task 8: Roll out annotations to remaining apps + enable them

After the pilot proves out (Renovate opens a correct grouped PR that passes `validate-apps`), extend annotations to every remaining app and flip the pilot gate off.

**Files:**
- Modify: `renovate.json5`; every remaining `apps/*/metadata.yaml`

**Interfaces:**
- Consumes: proven pilot config from Task 7.

- [ ] **Step 1: Remove the pilot gate**

In `renovate.json5`, delete the two pilot `packageRules` entries:
```json5
    { matchFileNames: ["apps/**"], enabled: false },
    { matchFileNames: ["apps/gogs/**", "apps/litellm/**", "apps/whoami/**"], enabled: true },
```
and replace the three per-app `groupName` rules with one generic rule so every app is grouped by its directory:
```json5
    { matchFileNames: ["apps/*/**"], groupName: "{{packageFileDir}}" },
```

- [ ] **Step 2: Add a `# renovate:` annotation above `version:` for every remaining app**

For each app not in the pilot, determine its primary upstream image/chart and add the annotation. Use the app's `overlays/*/kustomization.yaml` `images: name:` (docker datasource) or its `base/ocirepository.yaml` chart (for HelmRelease apps). For divergent apps (immich sidecar/patch, headscale/vaultwarden variants), annotate the **app image**, not the sidecar. Do one app per commit for reviewability.

Example (vaultwarden, image `vaultwarden/server`):
```yaml
  # renovate: datasource=docker depName=vaultwarden/server
  version: "1.37.0"
```

- [ ] **Step 3: Validate**

Run: `npx --yes --package renovate -- renovate-config-validator renovate.json5`
Expected: `Config validated successfully`.

- [ ] **Step 4: Commit (per app or in a batch)**

```bash
git add renovate.json5 apps/*/metadata.yaml
git commit -m "feat(renovate): enable update tracking for all apps"
```

---

## Self-Review

**Spec coverage:**
- D1 de-dup (sentinel + generator + guards) → Tasks 1–3 ✅
- marketplace-ui standardization → Task 4 ✅
- kubeconform tooling gap → Task 5 ✅
- validate-apps gate (build+kubeconform+flux) + on-demand e2e label → Task 6 ✅
- Renovate config (native + customManager + ignore infra + group + no auto-merge) → Task 7 ✅
- Pilot-first rollout → Task 7 (scoped) then Task 8 (full) ✅
- Required check (decision A) → Task 6 Step 4 (manual, documented) ✅

**Placeholder scan:** The only intentional stub is the `e2e` job body, explicitly flagged as a documented follow-up target (the label mechanism + skeleton ARE the D2 deliverable per spec's "C-on-demand"); the required `validate` job is fully functional. Task 8 Step 2 is per-app work that cannot be fully enumerated without inspecting each app, but gives the exact rule (use `images: name:` or chart, annotate app image not sidecar) and a worked example — acceptable as it's mechanical repetition of the Task 7 pattern.

**Type/name consistency:** Sentinel `__VERSION__` used identically in Tasks 1, 2, 4, and guards. `renovate-e2e` label consistent between Task 6 (`e2e` job condition) and Task 7 (`addLabels`). `validate` job name consistent between Task 6 and its required-check note.
