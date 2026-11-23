# FluxCD Developer Workflow

This document describes how to bootstrap a LibrePod cluster from scratch and
the workflow for modifying apps, validating changes, testing on the dev
cluster, and verifying reconciliation — **without requiring a merge to
`master`**.

All commands are run from the **repository root**.

---

## Prerequisites

Check if the `flux` CLI is provided.
If not provided, use it via nix-shell. Enter the dev shell before running any flux commands, or prefix each command with `nix-shell shell.nix --run`:

```bash
# Option A: enter nix shell once
nix-shell shell.nix

# Option B: prefix individual commands
nix-shell shell.nix --run "flux version"
```

**Cluster access**: the dev cluster kubeconfig lives at `~/.kube/librepod-dev.config`
(a symlink to the gitignored file in the `librepod-devices` repo — the sibling
`librepod-*.config` symlinks there are production devices, never point at them).
Pass it explicitly to every `flux`, `kubectl`, and `helm` call:

```bash
--kubeconfig ~/.kube/librepod-dev.config
```

**How a cluster syncs** (all objects in `flux-system`). There is no GitRepository for
this repo on a cluster — everything comes from signed OCI artifacts in GHCR:
- OCIRepository `marketplace-bootstrap` — `oci://ghcr.io/librepod/marketplace/bootstrap:latest`,
  rebuilt by `publish-bootstrap.yaml` on master; it carries `clusters/<cluster>/` and
  `infrastructure/`. The `system-apps` and `system-configs` Kustomizations build from it.
- One OCIRepository + Kustomization per system app, both named `<app>`, defined in
  `infrastructure/system-apps/<app>.yaml`. The OCIRepository pins
  `oci://ghcr.io/librepod/marketplace/apps/<app>` at `ref.tag` and verifies it with the
  project's cosign **public key** (`verify.secretRef: cosign-pub`).
- User-installed apps — `marketplace-<app>` objects that marketplace-ui writes into the
  on-cluster Gogs repo; Flux reads that repo through GitRepository `user-apps-source`.
  Their OCIRepositories do **not** verify signatures.

---

## Step 0 — Bootstrap a clean cluster

These steps set up a brand-new k3s cluster with FluxCD and the LibrePod
marketplace. The bootstrap installs two Helm charts — **flux-operator**
(manages the Flux lifecycle) and **flux-instance** (configures the sync
source) — which pull the bootstrap OCI artifact and begin deploying system
apps.

### 0a. Prerequisites

- A clean k3s (or similar) Kubernetes cluster
- `helm` CLI installed and configured
- Kubeconfig pointing at the target cluster

### 0b. Install flux-operator

The flux-operator is a Kubernetes operator that manages the lifecycle of Flux
controllers. Install it from the official OCI Helm chart:

```bash
helm install flux-operator oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator \
  --version 0.57.0 \
  --namespace flux-system \
  --set installCRDs=true \
  --create-namespace \
  --kubeconfig ~/.kube/librepod-dev.config
```

This deploys the operator with default values. No custom configuration is
needed — the operator watches for `FluxInstance` CRs and reconciles them.

### 0c. Install flux-instance

The `flux-instance` Helm chart creates a `FluxInstance` CR that tells the
operator where to find the initial sync source and which Flux controllers to
run. Only the `sync.*` values need to be set — everything else uses sensible
defaults (all four controllers, `cluster.local` domain, etc.):

```bash
helm install flux-instance oci://ghcr.io/controlplaneio-fluxcd/charts/flux-instance \
  --namespace flux-system \
  --version 0.57.0 \
  --set instance.sync.interval=1m \
  --set instance.sync.kind=OCIRepository \
  --set instance.sync.name=marketplace-bootstrap \
  --set instance.sync.path=./clusters/librepod-dev \
  --set instance.sync.ref=latest \
  --set instance.sync.url=oci://ghcr.io/librepod/marketplace/bootstrap \
  --kubeconfig ~/.kube/librepod-dev.config
```

### 0d. Verify bootstrap

After applying the FluxInstance, the operator will:
1. Deploy Flux controllers (source, kustomize, helm, notification)
2. Create an OCIRepository named `marketplace-bootstrap`
3. Pull the bootstrap artifact from `ghcr.io`
4. Create Kustomizations from the cluster path (`system-apps`, `system-configs`, etc.)
5. Begin deploying system apps following the dependency chain

Check progress:

```bash
# FluxInstance status — should show READY=True
kubectl --kubeconfig ~/.kube/librepod-dev.config get fluxinstance flux -n flux-system

# OCIRepository — should show the latest artifact pulled
kubectl --kubeconfig ~/.kube/librepod-dev.config get ocirepository marketplace-bootstrap -n flux-system

# Kustomizations — system-apps and system-configs should appear and reconcile
flux get kustomizations --kubeconfig ~/.kube/librepod-dev.config -n flux-system
```

The full deployment chain takes several minutes. The dependency order is:

```
storage (independent)
step-certificates → step-issuer → traefik → cert-manager
gogs (depends on storage + traefik)
casdoor, oauth2-proxy, wg-easy, whoami (various dependencies)
```

Once all Kustomizations show `READY=True`, the cluster is fully bootstrapped.

---

## Step 1 — Validate manifests locally

`--local-sources` replaces a Kustomization's OCI source with a directory of the
working tree, so the build applies all patches and variable substitutions
exactly as FluxCD would — but with your local files.

```bash
# The system-apps chain (no cluster contact: --dry-run + an explicit kustomization file)
flux build kustomization system-apps \
  --path ./infrastructure/system-apps \
  --kustomization-file ./clusters/librepod-dev/system-apps.yaml \
  --local-sources OCIRepository/flux-system/marketplace-bootstrap=./ \
  --dry-run

# A single app, offline (plain Kustomize, as CI's validate-apps does)
kustomize build ./apps/<app-name>/overlays/librepod

# A system app with Flux's substitutions, using the live Kustomization's spec
flux build kustomization <app-name> \
  --kubeconfig ~/.kube/librepod-dev.config \
  --path ./apps/<app-name>/overlays/librepod \
  --local-sources OCIRepository/flux-system/<app-name>=./apps/<app-name>
```

Validate the rendered output with `kubeconform` to catch schema errors early
(`-ignore-missing-schemas` covers in-house CRDs with no public schema):

```bash
kustomize build ./apps/<app-name>/overlays/librepod \
  | kubeconform \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      -strict -ignore-missing-schemas -summary
```

---

## Step 2 — Diff local changes against the live cluster

`flux diff` shows exactly what would change on the cluster if the current local
state were applied. A clean diff (no output) means the cluster already matches
local changes.

```bash
# Diff the system-apps chain
flux diff kustomization system-apps \
  --kubeconfig ~/.kube/librepod-dev.config \
  --path ./infrastructure/system-apps \
  --kustomization-file ./clusters/librepod-dev/system-apps.yaml \
  --local-sources OCIRepository/flux-system/marketplace-bootstrap=./

# Diff a system app
flux diff kustomization <app-name> \
  --kubeconfig ~/.kube/librepod-dev.config \
  --path ./apps/<app-name>/overlays/librepod \
  --local-sources OCIRepository/flux-system/<app-name>=./apps/<app-name>
```

Exit code `1` with diff output means there are pending changes. Exit code `0`
means no drift.

---

## Step 3 — Test on a cluster before merging

A cluster only runs what is published to GHCR, so a branch is tested through the
artifacts CI publishes for its pull request. Open a PR: `publish-apps.yaml` pushes
every changed app as `oci://ghcr.io/librepod/marketplace/apps/<app>:pr-<N>` and
comments the tags on the PR.

### 3a. User-installed apps — use the `pr-<N>` artifact

User-app OCIRepositories don't verify signatures, so the `pr-<N>` artifact
installs as-is. The `verify-app` skill (`.claude/skills/verify-app/`) renders the
app's templates with that tag, commits them to the cluster's Gogs `user-apps`
repo, lets Flux reconcile, and checks the result.

### 3b. System apps and the bootstrap — `pr-<N>` will not verify

PR artifacts are signed **keylessly** (no access to the signing key from a PR),
while system-app OCIRepositories verify against the project's public key. Pointing
one at `pr-<N>` fails with `no matching signatures were found`. For a system-app or
`infrastructure/` change:

- validate and diff it locally (Steps 1–2) against a cluster that runs master;
- for a full fresh-install check, boot a throwaway k3d cluster — `clusters/librepod-k3d`
  is the target the Tier 2 e2e suite uses (see `ui/CLAUDE.md`, "E2E Tier 2");
- after merge, master publishes signed `:latest` artifacts, and a released version
  moves a cluster only when its pin in `infrastructure/system-apps/<app>.yaml` moves.

### 3c. Force reconciliation

To pick up a republished tag now instead of at the next interval, see
"Stale OCI artifacts" under Troubleshooting.

---

## Step 4 — Verify reconciliation

Run these commands after any reconcile to confirm the cluster reached the
desired state.

### Check kustomization status

```bash
flux get kustomizations \
  --kubeconfig ~/.kube/librepod-dev.config \
  -n flux-system
```

Expected output: all relevant kustomizations show `READY=True` and the revision
matches the expected artifact tag and digest.

### Inspect the resource tree

```bash
flux tree kustomization <kustomization-name> \
  --kubeconfig ~/.kube/librepod-dev.config
```

### Tail reconciliation logs

```bash
flux logs \
  --kubeconfig ~/.kube/librepod-dev.config \
  --kind=Kustomization \
  --name=<kustomization-name> \
  --namespace=flux-system \
  --tail=30
```

### Check deployed pods (optional deep verification)

```bash
kubectl --kubeconfig ~/.kube/librepod-dev.config \
  get pods -n <app-namespace>
```

---

## Troubleshooting

### HelmRelease stuck in "RetriesExceeded" / "Failed" state

When a HelmRelease fails repeatedly, it can get stuck with `Stalled=True` and
won't retry even after fixing the underlying issue. Delete it to let FluxCD
recreate it fresh:

```bash
# Check HelmRelease status
kubectl --kubeconfig ~/.kube/librepod-dev.config get helmrelease -n <namespace> <name>

# Delete stuck HelmRelease (FluxCD will recreate from Kustomization)
kubectl --kubeconfig ~/.kube/librepod-dev.config delete helmrelease -n <namespace> <name>

# Trigger reconciliation
flux reconcile kustomization <kustomization-name> --kubeconfig ~/.kube/librepod-dev.config
```

### Service port vs targetPort confusion

When a Service exposes port X forwarding to targetPort Y, clients must connect
to port X (the Service port), not Y (the container port). This commonly trips
up init containers and health checks that try to connect directly.

### Flux `postBuild.substitute` mangling shell scripts in ConfigMaps

Flux's `postBuild.substitute` processes `${VAR}` patterns in **all** manifest
content — including ConfigMap data. This silently breaks shell scripts that use
`${VAR:-default}` syntax, because Flux interprets them as its own variable
substitutions:

```bash
# What you wrote (shell parameter expansion):
CA_MAX_TLS_DURATION="${CA_MAX_TLS_DURATION:-${CA_DEFAULT_TLS_DURATION}}"

# What Flux outputs (variables not in substitute map → empty string):
CA_MAX_TLS_DURATION=""
```

**Fix**: add the `kustomize.toolkit.fluxcd.io/substitute: disabled` annotation to
the ConfigMapGenerator that contains the script. This tells Flux to skip variable
substitution for that specific resource:

```yaml
configMapGenerator:
  - name: my-script
    files:
      - script.sh=my-script.sh
    options:
      annotations:
        kustomize.toolkit.fluxcd.io/substitute: disabled
```

### Stale OCI artifacts (source-controller cache)

When you re-publish an OCI artifact at the same tag (e.g. after deleting and
re-pushing), the source-controller may still serve a cached copy with the old
digest. Force it to re-pull:

```bash
# Force re-pull of a specific OCIRepository
flux reconcile source oci <name> -n flux-system

# Then reconcile the kustomization that depends on it
flux reconcile kustomization <kustomization-name> --with-source
```

Verify the digest matches what you expect:

```bash
# Check the digest the source-controller has
kubectl get ocirepository <name> -n flux-system -o jsonpath='{.status.artifact.digest}'

# Pull and inspect the artifact locally to compare
flux pull artifact oci://ghcr.io/<path>:<tag> -o /tmp/artifact
```

---

## Quick-reference cheatsheet

| Goal | Command |
|------|---------|
| Bootstrap clean cluster | `helm install flux-operator oci://ghcr.io/controlplaneio-fluxcd/charts/flux-operator ...` then `helm install flux-instance oci://ghcr.io/controlplaneio-fluxcd/charts/flux-instance --set instance.sync.*` |
| Preview rendered manifests locally | `kustomize build ./apps/<app>/overlays/librepod`, or `flux build kustomization <app> ... --local-sources OCIRepository/flux-system/<app>=./apps/<app>` |
| Show drift vs cluster | `flux diff kustomization <app> ... --local-sources OCIRepository/flux-system/<app>=./apps/<app>` |
| Force reconcile (source + kustomization) | `flux reconcile kustomization <name> --kubeconfig ... --with-source` |
| Check all kustomization statuses | `flux get kustomizations --kubeconfig ... -n flux-system` |
| View resource tree | `flux tree kustomization <name> --kubeconfig ...` |
| View reconciliation logs | `flux logs --kubeconfig ... --kind=Kustomization --name=<name> -n flux-system --tail=30` |
| Test a branch on a cluster | open a PR, then install its `pr-<N>` artifact with the `verify-app` skill (user apps only — see Step 3) |
| Force re-pull OCI artifact | `flux reconcile source oci <name> -n flux-system` |
