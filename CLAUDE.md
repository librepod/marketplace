# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LibrePod Apps** is a Marketplace of pre-configured applications for one-click installation 
on LibrePod Kubernetes clusters. We use GitOps principles with FluxCD for deploying and
managing applications.

## Repository Structure

```
apps/                   # Individual application deployments
├── traefik/            # Traefik ingress controller
├── wg-easy/            # WireGuard VPN
└── [other apps]/       # Additional applications (baikal, litellm, vaultwarden, etc.)
```

## Development Environment

A development Kubernetes cluster is available for testing:

- **Cluster name**: `librepod-dev`
- **Access**: hostname `librepod-dev` (IP may change; the kubeconfig file always has the current address)
- **Kubeconfig**: `./librepod-dev.config` (in repo root, gitignored)

Always use the kubeconfig flag when interacting with the cluster:

```bash
kubectl --kubeconfig ./librepod-dev.config get pods -A
```

## Common Development Commands

### Root-level Commands (run from `/apps`)

```bash
# Build kustomize manifests
kustomize build ./apps/<app-name>/overlays/librepod

# Apply to dev cluster
kustomize build ./apps/<app-name>/overlays/librepod | kubectl --kubeconfig ./librepod-dev.config apply -f -
```

## Architecture Patterns

**Key conventions:**
- Each app creates its own namespace (named after the app)

### 1. TLS / IngressRoute Convention

All apps expose HTTP via Traefik `IngressRoute` resources. TLS certificates are handled by
Traefik's default certificate store — apps do **not** configure `tls:` blocks on their
IngressRoutes unless they need a specific cert resolver or custom TLS options. The default
certificate is provisioned by cert-manager and applied cluster-wide via Traefik's TLS store.

### 2. FluxCD Integration

FluxCD is the central GitOps operator. Its configs are located under `clusters/` and
`infrastructure/` directories. The FluxCD is being installed by the LibrePod server
deployment step using helm charts flux-operator and flux-instance. The
FluxInstance CRD is pointed to this repository (i.e. `./clusters/librepod`
folder) in order to pull its original state.

## Development Workflow

1. **Create/Edit App**: Modify Kustomization code in `apps/<app-name>/base.yaml` or `overlay/librepod/` files
2. **Test Build**: Run `kustomize build apps/<app-name>/overlay/librepod` to verify manifests
3. **Deploy to Dev**: Apply to `librepod-dev` cluster for testing
4. **Commit**: Generated YAML in `<app-name>/` is committed to Git

For the full FluxCD-based workflow — including how to validate manifests locally,
diff changes against the live cluster, test from a feature branch, and verify
reconciliation — see @docs/FLUX_WORKFLOW.md

## Important Notes

- **Do not parse the entire `./apps/` folder** unless explicitly asked to. Each app is self-contained — only dive into the specific app you're working on.
- **Do not create namespaces manually** - Apps are responsible for creating their own namespaces
- **Testing**: Uses Kustomize build command
- **`catalog.yaml` is generated in CI only — never committed.** CI regenerates it from
  `apps/*/metadata.yaml`, wraps it with the template in `apps/catalog-artifact/`, and pushes
  the result as a cosign-signed OCI artifact (`oci://ghcr.io/librepod/marketplace/catalog`).
  Clusters consume it via `infrastructure/system-apps/marketplace-catalog.yaml`, whose
  Kustomization renders the `marketplace-catalog` ConfigMap the marketplace-ui mounts.
  When bumping an app version, edit only the source of truth (`metadata.yaml` `spec.version`,
  plus the overlay image tag and the `ref.tag` in `infrastructure/system-apps/<app>.yaml`);
  the catalog updates on all clusters within ~5 min of merge. For local UI development run
  `bash ./scripts/generate-catalog.sh` — the root `catalog.yaml` it writes is gitignored.
- **Commit, PR & public-doc hygiene**: never reference specific device or cluster hostnames (e.g. `librepod-dev`, `librepod-beelink`) in commit messages, PR titles/descriptions, or public-facing docs (READMEs). Use abstract environment pointers instead — `dev`, `prod`, `staging`. (Internal dev workflow docs like `docs/FLUX_WORKFLOW.md` may keep the operational cluster name.)
- **Bootstrap versioning**: OCI streams for `marketplace/bootstrap` are
  `latest` / `0.0.0-<sha>` (rolling, master pushes via `publish-bootstrap.yaml`),
  `pr-<N>` (per PR, keyless), and `marketplace-bootstrap-X.Y.Z` (stable cuts:
  push a git tag `marketplace-bootstrap-X.Y.Z` — `release-bootstrap.yaml`
  builds, pushes, and COSIGN-key-signs it; `latest` is never moved). Each
  marketplace component prefixes its git release tags with its own name
  (`marketplace-<component>-X.Y.Z`); plain `v*` is unclaimed. os pins a fixed
  `marketplace-bootstrap-X.Y.Z` in `modules/k3s/charts/flux-instance.nix`, and
  the Flux bootstrap source (OCIRepository / FluxInstance sync name) is
  `marketplace-bootstrap` to match the OCI path.

### PVC/PV Deletion with NFS Storage

The cluster uses NFS as the default storage class. When a PVC and its PV are deleted, the underlying
NFS folder on the NFS server **is not deleted**. If a new PVC is created with the same name, it will
rebind to the same NFS folder and contain the old data. To truly reset PVC data, you must manually
clean the NFS folder contents (e.g., via a temporary job running as root with `rm -rf /data/*`).
