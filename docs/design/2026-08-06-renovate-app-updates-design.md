# Design: Automated App Update Tracking with Renovate

**Date:** 2026-08-06
**Status:** Approved (design phase)
**Author:** Alex Sukhov (with Claude)

## Problem

Tracking upstream version updates for every app in `apps/` is manual and
tedious. We want a bot that scans each app for new upstream releases and opens
PRs with the version bumps, and we want those PRs to be automatically validated
so a green check means "the manifests still build correctly."

## Goals

- **Audit & normalize apps first** so every app follows the same
  `metadata.yaml` schema and has a single, trackable version source, before
  Renovate is configured. Inconsistent apps otherwise force per-app Renovate
  hacks. A re-runnable `scripts/audit-apps.sh` doubles as a standing drift lint.
- Renovate opens PRs for **every** app in `apps/` when an upstream image or
  Helm chart has a newer version.
- Each PR is **complete**: it bumps the concrete image/chart tag **and** the
  app's single headline version (`spec.version` in `metadata.yaml`) together.
- Each PR is **validated** by CI before the author looks at it (build + schema
  lint + Flux render), with an **opt-in** deeper end-to-end deploy for risky
  bumps.
- The maintainer keeps **full manual control** over system-app adoption onto
  clusters.

## Non-Goals

- No auto-merge. Every PR is reviewed by a human.
- No change to how apps are published (`publish-apps.yaml`) or how the catalog
  is shipped, beyond the version de-duplication in Deliverable 1.
- No repo-wide refactor to derive image tags *from* `spec.version` (considered
  as option C during design; deferred as a separate future project).
- Renovate does **not** manage `infrastructure/system-apps/*.yaml`. Adoption of
  a new system-app version onto a cluster stays a deliberate, specially-tested
  manual edit.

---

## Key facts discovered during design

These shaped every decision below; they are recorded so the implementer does
not re-derive them.

1. **A single app's version lives in up to three places.** For a typical app:
   - `apps/<app>/overlays/librepod/kustomization.yaml` → `images: newTag`
     (or a Helm chart pin / HelmRelease patch tag, depending on archetype)
   - `apps/<app>/metadata.yaml` → `spec.version`
   - `apps/<app>/metadata.yaml` → `templates.source.ref.tag`
   For the **14 system apps** there is also a copy in
   `infrastructure/system-apps/<app>.yaml` → `ref.tag`.

2. **`spec.version` and `templates.source.ref.tag` are always identical** (same
   value typed twice) for every app **except `marketplace-ui`** (which had no
   `templates:` block at all). Verified across all 28 apps. This makes the
   `ref.tag` copy pure, mechanical redundancy — safe to generate.

3. **`spec.version` is load-bearing, not cosmetic.** `publish-apps.yaml` reads
   it to tag the published OCI artifact; `generate-catalog.sh` embeds the
   `templates.source` block (containing `ref.tag`) **verbatim** into
   `catalog.yaml`, which ships to user clusters as the Flux `OCIRepository`
   they apply. So `ref.tag` **must** equal `spec.version`, and any placeholder
   used during de-duplication must **never** leak into `catalog.yaml`.

4. **`spec.version` cannot be mechanically derived from a single upstream image**
   for every app. Examples of divergence between `spec.version` and the
   `overlays` image tag: `immich` (overlay tag is a **postgres sidecar**, app
   version is in a HelmRelease patch), `headscale` (`v0.28.0` vs
   `v0.28.0-debug`), `vaultwarden` (`1.37.0` vs `1.37.0-alpine`). Therefore
   `spec.version` needs an explicit per-app annotation telling Renovate which
   upstream drives it — it cannot be inferred.

5. **`marketplace-ui` is a system app that was under-implemented.** Every other
   system app (gogs, traefik, casdoor, cert-manager, …) carries a full
   `templates:` block in `metadata.yaml` *and* is installed via
   `infrastructure/system-apps/`. `marketplace-ui` was missing its `templates:`
   block and carried a duplicate `appVersion` field. It is standardized in
   Deliverable 1.

6. **CI has no correctness gate today.** On a PR, `publish-apps.yaml` reads
   `spec.version` and immediately publishes+signs a `pr-N` OCI artifact. It
   never runs `kustomize build` or `kubeconform`. "Green" today means "artifact
   published," not "manifests valid." (Also: `pr-N` artifacts are keyless-signed
   and fail the cluster's key-based cosign verify, so they cannot reconcile —
   they are previews, not a validation signal.) A real validation gate must be
   added.

7. **Tooling:** `shell.nix` provides `fluxcd`, `kustomize`, `kubectl`, `k3d`,
   `jq` — but **not `kubeconform`**. The validation workflow must add it.

8. **`detect-changes` diff logic** (git-diff `apps/` → JSON matrix of changed
   apps with a `metadata.yaml`) already exists in `publish-apps.yaml` and is
   self-contained. It is copied into the new workflow (GitHub Actions cannot
   share a plain job across workflow files without a `workflow_call` refactor,
   which is out of scope).

---

## Version-declaration archetypes (Renovate coverage)

| Version location | Renovate mechanism | Example |
|---|---|---|
| `overlays/*/kustomization.yaml` `images: newTag` | native **kustomize** manager | gogs `gogs/gogs:0.14.3`, litellm `v1.93.0` |
| `base/ocirepository.yaml` chart `ref.semver`/`ref.tag` | native **flux** manager | immich chart `0.13.*` |
| `overlays/*/patch-helmrelease.yaml` `image.tag` | **customManager** (it is a kustomize patch, not a Helm values file) | immich `main.image.tag: v3.0.3` |
| Inline `image: repo:tag` in a Deployment (no `images:` transformer) | **normalize** → move to `images:` transformer, then native kustomize | casdoor-sso-controller `ghcr.io/librepod/casdoor-sso-controller:0.2.5` |
| Remote kustomize base pinned by git ref in URL (`...?ref=<tag>`) | **customManager** + `github-tags`/`git-tags` datasource | nfs-provisioner `?ref=nfs-subdir-external-provisioner-4.0.18` |
| `metadata.yaml` `spec.version` | **customManager** + per-app annotation | every app |

## Canonical `metadata.yaml` schema (derived by frequency)

- **Required (28/28 apps have it):** `name`, `displayName`, `description`,
  `category`, `website`, `version`, `source`.
- **Required, fix gaps:** `templates` (missing only marketplace-ui — fixed),
  `dependencies` (missing casdoor-sso-controller, frp-operator, rustdesk),
  `icon` (missing casdoor-sso-controller, frp-operator, rustdesk).
- **Conditional / legitimately optional:** `params` (present when the app takes
  install params), `secrets` (present when the app needs generated secrets).
  Absence is NOT a defect.
- **Outliers to remove:** `notes` (tailscale only), `appVersion` (marketplace-ui
  only).

## App-audit findings (2026-08-06)

Notable inconsistencies the audit must track and normalization must fix:
- `marketplace-ui`: `appVersion` dup + no `templates` (system app; standardized).
- `tailscale`: stray `notes` key.
- `casdoor-sso-controller`, `frp-operator`, `rustdesk-server-oss`: missing
  `icon` (and `params`/`dependencies` for some).
- `casdoor-sso-controller`: image tag inline in Deployment, no `images:`
  transformer → not natively trackable until moved.
- `nfs-provisioner`: no in-repo image at all; deploys from a remote GitHub
  kustomize base pinned by git ref → distinct archetype needing an annotation.
- `immich`, `step-certificates`: multi-archetype (chart + kustomize images +
  patch) → `spec.version` annotation must target the app image, not a sidecar.

---

## Deliverable sequencing (updated after the app audit)

The implementation plan sequences the work as: **D0 audit** (re-runnable
`scripts/audit-apps.sh` → report) → **validation gate** (kubeconform +
`validate-apps.yaml`, built early so structural fixes are CI-checked) →
**de-duplicate `spec.version`** (below) → **normalize apps to the canonical
schema and a single trackable version source** (scope B, driven by the audit) →
**Renovate** (pilot then full). The two sections below describe the de-dup and
Renovate mechanics in detail; the plan file holds the task-by-task ordering.

## Deliverable 1 — De-duplicate `spec.version` (schema cleanup, no Renovate)

**Purpose:** collapse the `spec.version` / `templates.source.ref.tag`
redundancy so there is **one** version string per app in `metadata.yaml`, and
standardize `marketplace-ui`. This is a strict improvement independent of
Renovate and must be provably behavior-neutral.

### 1a. Replace the duplicated `ref.tag` with a sentinel

In every app's `metadata.yaml`, the `templates.source` block's ref becomes:

```yaml
        ref:
          tag: "__VERSION__"     # was: tag: "0.14.3"
```

- `spec.version: "0.14.3"` remains the **sole** real version string.
- Sentinel is `__VERSION__` (double-underscore), **not** `${VERSION}` — because
  `${...}` collides with Flux's `postBuild.substitute` syntax that already runs
  over these template blocks. A bare sentinel cannot be misinterpreted by Flux.
- Uniform across all apps: verified every source template's ref block is exactly
  `ref:` / `tag: "<version>"` at 10-space indent.

### 1b. Generate `ref.tag` from `spec.version` in `generate-catalog.sh`

After `extract_template_block "$metadata_file" "source"` produces `$TMPL_SOURCE`,
substitute the sentinel with the already-extracted `$VERSION` before writing:

```bash
TMPL_SOURCE=$(printf '%s' "$TMPL_SOURCE" | sed "s/__VERSION__/${VERSION}/g")
```

### 1c. Guardrails (the acceptance tests for this deliverable)

- **Byte-identical regen:** run `generate-catalog.sh`, then diff ignoring the
  always-changing `generatedAt` timestamp line, e.g.
  `git diff catalog.yaml | grep -v 'generatedAt'` — the only content diff
  expected is marketplace-ui's new `templates:` entry (from 1d). For every other
  app the diff must be empty. This proves the sentinel refactor changed no
  shipped behavior. (Note: `generate-catalog.sh` re-stamps `generatedAt` on
  every run, so a raw `git diff` always shows that one line — exclude it.)
- **Leak guard in the script:** after generation,
  `grep -q '__VERSION__' "$CATALOG_FILE" && { echo "sentinel leaked"; exit 1; }`.
  Belt-and-suspenders against a raw sentinel reaching a user cluster.
- **Non-empty version guard:** fail generation if any app's `spec.version` is
  empty (it is now the only source).

### 1d. Standardize `marketplace-ui`

- **Add** the standard `templates:` block (`source` + `release` +
  `kustomization`) using the `__VERSION__` sentinel, modeled on the app's own
  `infrastructure/system-apps/marketplace-ui.yaml` (namespace `flux-system`,
  `dependsOn: [gogs, cert-manager, casdoor-sso-controller]`, `path:
  ./overlays/librepod`, `postBuild.substitute.BASE_DOMAIN`). Match the shape of
  a peer system app's template (e.g. gogs) but with marketplace-ui's real
  dependencies.
- **Remove** the duplicate `appVersion: "0.4.0"` field. `version` becomes the
  single source, consistent with all other apps.
- After this, marketplace-ui's `metadata.yaml` is a normal citizen: catalog
  generation and Renovate treat it uniformly.
- Note: adding `templates:` **will** change `catalog.yaml`'s marketplace-ui
  entry — that specific diff is expected and reviewed; the byte-identical check
  in 1c applies to all *other* apps.

**Out of scope for Deliverable 1:** kustomize `images:` tags, HelmRelease image
tags, OCIRepository chart pins, and all `infrastructure/system-apps/*.yaml`
files are left untouched.

---

## Deliverable 2 — Renovate + validation

### 2a. `renovate.json5` (repo root)

JSON5 so per-app rules can be commented.

**Layer 1 — native managers (no per-app work):**
- `kustomize` manager → bumps `overlays/*/kustomization.yaml` `images: newTag`.
- `flux` manager → bumps `base/ocirepository.yaml` chart `ref.semver`/`ref.tag`.

**Layer 2 — customManagers:**
- **`spec.version` manager:** `managerFilePatterns` = `apps/*/metadata.yaml`.
  Driven by a `# renovate: datasource=<ds> depName=<pkg>` comment placed
  directly above each `version:` line. This is how `spec.version` learns which
  upstream drives it (fact #4). One annotation per app, added incrementally.
- **HelmRelease-patch-tag manager:** `managerFilePatterns` =
  `apps/*/overlays/*/patch-helmrelease.yaml`, matching `image.tag:` lines,
  annotated the same way (immich archetype).

**Layer 3 — `packageRules` / config:**
- `"ignorePaths": ["infrastructure/**"]` — hard enforcement of the "never touch
  system-apps infra" decision. Renovate never reads those files.
- **One PR per app:** `matchFileNames: ["apps/<app>/**"]` → `groupName: "<app>"`
  so an app's image bump + `spec.version` bump (+ sidecar) land in a single PR.
- **Majors separated + labeled:** `matchUpdateTypes: ["major"]` →
  `addLabels: ["renovate-e2e"]` (feeds the on-demand e2e job) and its own PR.
- `"dependencyDashboard": true` for visibility.
- **No auto-merge** anywhere.

**Note on the (i) decision (system apps):** Renovate bumps the `apps/`-side of
system apps normally (image tag + `spec.version`). On merge, `publish-apps.yaml`
publishes a new OCI artifact — but nothing deploys, because the cluster pulls
from `infrastructure/system-apps/<app>.yaml`, which Renovate never edits. The
PR is a "new version is built and ready; you adopt it manually when tested"
signal. This is the intended behavior, not a gap.

### 2b. `.github/workflows/validate-apps.yaml` — the validation gate

**Trigger:** `pull_request` on `apps/**` (covers Renovate PRs and manual PRs
alike).

**Job `detect-changes`:** copy the diff-to-matrix logic from
`publish-apps.yaml`.

**Job `validate` (matrix over changed apps), the B-required gate — for each app:**
1. `kustomize build apps/<app>/overlays/librepod`
2. pipe to `kubeconform -strict` with the CRD schema locations from
   `docs/FLUX_WORKFLOW.md`
3. `flux build kustomization … --local-sources
   GitRepository/flux-system/librepod-apps=./` — exercises Flux's
   `postBuild.substitute` rendering (the `${VAR}` bug class).

Run inside `nix-shell shell.nix`. **Add `kubeconform`** (either
`pkgs.kubeconform` in `shell.nix` or install in-workflow — implementer's
choice; prefer `shell.nix` for version pinning). No cluster, no secrets,
~1–2 min.

**Job `e2e` (on-demand, C-on-demand):** same workflow, gated
`if: contains(github.event.pull_request.labels.*.name, 'renovate-e2e')`.
Reuses the existing `k3d`-based e2e flow (modeled on `ui-e2e-cluster.yaml` /
the `verify-app` skill) to deploy the bumped app to an ephemeral cluster and
smoke-test it. Auto-applied to major bumps by Renovate; addable by hand to any
PR. Patch/minor PRs skip it.

**Required status check:** `validate-apps` is made a **required** check for
**all** `apps/**` PRs (decision A) — manual PRs are blocked on red too, so
schema drift is caught regardless of author. (Repo/branch-protection setting,
noted for the implementer; not a code change.)

**Relationship to `publish-apps.yaml`:** unchanged and additive. It keeps
publishing `pr-N` previews; `validate-apps.yaml` supplies the correctness signal
that was missing.

---

## Rollout / sequencing

1. **Deliverable 1** first, verified by the byte-identical catalog regen. Ship
   and merge before touching Renovate.
2. **Deliverable 2** on top: add `validate-apps.yaml` (and `kubeconform`) →
   confirm it passes on a no-op PR → add `renovate.json5` with a **small pilot**
   (2–3 unambiguous apps, e.g. gogs + litellm + whoami) → confirm Renovate opens
   a correct, single-PR-per-app, green bump → then roll annotations out to the
   remaining apps incrementally.
3. Make `validate-apps` a required check once it is proven green on real PRs.

## Open items deferred (not blocking)

- Full option (C): derive image tags *from* `spec.version` repo-wide. Future.
- De-duplicating the `infrastructure/system-apps/*.yaml` `ref.tag` against
  `spec.version`. Deliberately left manual per the control decision.

## Acceptance criteria

- **D1:** one version string per app in `metadata.yaml`; `generate-catalog.sh`
  produces a byte-identical `catalog.yaml` for all apps except marketplace-ui;
  sentinel leak-guard active; marketplace-ui standardized (has `templates:`, no
  `appVersion`).
- **D2:** Renovate opens one grouped PR per app with an upstream update, bumping
  the concrete tag + `spec.version` together; never edits `infrastructure/**`;
  every `apps/**` PR runs `validate-apps` (build + kubeconform + flux build) as
  a required check; major bumps carry `renovate-e2e` and can run the ephemeral
  e2e job on demand.
