# Phase 5: Containerization & Deployment - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Package the marketplace UI as a containerized system app and deploy it into the LibrePod bootstrap chain. This phase delivers: (1) a multi-stage Dockerfile that builds the React SPA and NestJS API into a single container, (2) Kubernetes manifests (Deployment, Service, IngressRoute, ServiceAccount+RBAC, ConfigMap) following the existing app pattern, (3) integration into the system-apps bootstrap dependency chain. No application code changes (the server already has all endpoints from Phases 1-4). No new features.

</domain>

<decisions>
## Implementation Decisions

### Docker Build Strategy
- **D-01:** **Multi-stage Dockerfile** — Stage 1 (`builder`): `node:22-alpine`, install all deps, build client (`vite build`), build server (`nest build`). Stage 2 (`production`): `node:22-alpine`, copy built server dist/ and client dist/, install production deps only (`npm ci --omit=dev`).
- **D-02:** **NestJS serves static files directly** — add `serve-static` middleware (or equivalent) to serve the Vite build output from a configurable path (e.g., `STATIC_PATH=/app/client`). Single process, single port. No nginx, no sidecar.
- **D-03:** **Base image: `node:22-alpine`** — smaller image, full shell for debugging, well-documented.
- **D-04:** Container exposes a single port (default 3000, configurable via `PORT` env var). API at `/api/*`, SPA at all other routes. SPA fallback (index.html) for client-side routing.

### K8s Manifest Design
- **D-05:** **Standard app directory structure** at `apps/marketplace-ui/` with `base/` and `overlays/librepod/` — same pattern as whoami, vaultwarden, etc. Published as OCI artifact.
- **D-06:** **Deployment** with a single replica (Recreate strategy), resource requests/limits appropriate for a lightweight API server.
- **D-07:** **ClusterIP Service** on port 80 → targetPort 3000.
- **D-08:** **Traefik IngressRoute** at `marketplace.${BASE_DOMAIN}` with TLS (cert-manager issuer). Same pattern as all other system apps.
- **D-09:** **ConfigMap** containing `catalog.yaml` — mounted as a volume into the container at the path configured by `CATALOG_PATH` env var. Leverages Phase 1's `fs.watch` hot-reload: updating the ConfigMap triggers a file change event → catalog refreshes without pod restart.
- **D-10:** **Dedicated ServiceAccount** with a **ClusterRole** granting `get`, `list`, `watch` on `kustomizations.kustomize.toolkit.fluxcd.io` and `helmreleases.helm.toolkit.fluxcd.io` across all namespaces. Bound via ClusterRoleBinding. Designed in Phase 3, manifests created here.

### Bootstrap Integration
- **D-11:** **Dependency ordering**: marketplace-ui depends on Gogs (needs GOGS_URL for install state reads/writes) and cert-manager (needs TLS certs for ingress). Does NOT depend on NFS (catalog comes from ConfigMap). Starts after Gogs and cert-manager are ready.
- **D-12:** **Gogs authentication** reuses the existing `user-apps-source-auth` secret in `gogs` namespace. Reflector (already deployed as a system app) copies it to the marketplace-ui namespace. GOGS_URL set to `http://gogs.gogs.svc.cluster.local:80` (cluster-internal DNS).
- **D-13:** **Environment variables** for the container:
  - `PORT` — server listen port (default 3000)
  - `CATALOG_PATH` — path to catalog.yaml inside container (mounted from ConfigMap)
  - `GOGS_URL` — internal Gogs API URL
  - `GOGS_TOKEN` — from reflected secret
  - `ALLOWED_ORIGIN` — CORS origin (set to the ingress URL or `*` for same-origin)
  - `STATIC_PATH` — path to built React SPA files (for serve-static)

### Claude's Discretion
- Exact Dockerfile layer caching strategy (what to copy when to maximize cache hits)
- Health probe configuration (liveness/readiness on `/api/health`)
- Resource requests/limits values
- ConfigMap update mechanism (FluxCD will handle this via the OCI artifact)
- Whether to add the marketplace-ui to `.github/workflows/publish-apps.yaml` or create a separate workflow
- Container image tag strategy (SHA-based, latest, semver)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing App Patterns
- `apps/whoami/` — Simplest system app pattern: base/deployment.yaml, base/service.yaml, overlays/librepod/ingressroute.yaml
- `apps/vaultwarden/` — More complex app with PVC, probes, env vars, and secrets — good reference for env var injection pattern
- `apps/vaultwarden/metadata.yaml` — Full metadata with params, secrets, templates

### System App Bootstrap
- `infrastructure/system-apps/` — Individual YAML files for each system app's FluxCD Kustomization
- `clusters/librepod-dev/system-apps.yaml` — Top-level system-apps Kustomization with `dependsOn` declarations and `postBuild.substituteFrom`
- `clusters/librepod/system-apps.yaml` — Production variant

### CI/CD
- `.github/workflows/publish-apps.yaml` — OCI artifact publishing workflow with `flux push artifact` and Cosign signing

### Server Code
- `ui/packages/server/src/main.ts` — NestJS bootstrap: listens on PORT, sets `/api` prefix, CORS from ALLOWED_ORIGIN
- `ui/packages/server/src/catalog/catalog.service.ts` — Loads catalog from CATALOG_PATH with fs.watch hot-reload
- `ui/packages/server/src/installed/gogs.service.ts` — GogsService: GOGS_URL + GOGS_TOKEN env vars, reads user-apps repo

### Frontend Build
- `ui/packages/client/package.json` — `vite build` produces static files in `dist/`
- `ui/packages/client/vite.config.ts` — Vite configuration (build output path, etc.)

### Gogs Integration
- `infrastructure/user-apps-source/gitrepository.yaml` — Gogs URL pattern: `http://gogs.gogs.svc.cluster.local:80/flux/user-apps.git`
- `infrastructure/user-apps-source/user-apps.yaml` — FluxCD Kustomization watching user-apps repo

### Requirements
- `.planning/REQUIREMENTS.md` — Phase 5 covers DEPL-01 (bootstrap system app), DEPL-02 (single container SPA+API), DEPL-03 (no auth)

### Prior Phase Context
- `.planning/phases/04-install-uninstall/04-CONTEXT.md` — Install/uninstall service, Gogs write operations, mutex pattern
- `.planning/phases/03-installed-apps-live-status/03-CONTEXT.md` — GogsService read pattern, FluxCD status model, ServiceAccount+RBAC design
- `.planning/phases/01-backend-foundation-catalog-api/01-CONTEXT.md` — NestJS module structure, CATALOG_PATH env var, fs.watch hot-reload

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ui/packages/server/src/main.ts` — Already has CORS and prefix config. Phase 5 adds serve-static middleware here.
- `ui/packages/server/src/catalog/catalog.service.ts` — Already watches CATALOG_PATH for changes. ConfigMap volume mount triggers this automatically.
- `ui/packages/server/src/installed/gogs.service.ts` — Already uses GOGS_URL/GOGS_TOKEN env vars. No changes needed.
- `ui/packages/client/` — `vite build` already produces static files. No changes needed.

### Established Patterns
- NestJS `ConfigService` for env vars (`CATALOG_PATH`, `GOGS_URL`, `GOGS_TOKEN`, `PORT`)
- Standard app Kustomize structure: `apps/<name>/base/` + `overlays/librepod/`
- FluxCD `postBuild.substituteFrom` for env var injection from ConfigMaps/Secrets
- Traefik IngressRoute with TLS via cert-manager
- OCI artifact publishing via `flux push artifact` + Cosign signing
- Reflector for cross-namespace secret replication

### Integration Points
- `apps/marketplace-ui/` — New app directory with K8s manifests
- `infrastructure/system-apps/marketplace-ui.yaml` — FluxCD Kustomization for the new system app
- `clusters/librepod-dev/system-apps.yaml` — Add `dependsOn` for marketplace-ui after Gogs and cert-manager
- `.github/workflows/publish-apps.yaml` — Add marketplace-ui to the app publishing matrix
- `catalog.yaml` — Source for the ConfigMap content

</code_context>

<specifics>
## Specific Ideas

- ConfigMap for catalog.yaml is elegant: FluxCD keeps it in sync with the OCI artifact, and Phase 1's fs.watch picks up changes automatically. No special reload mechanism needed.
- The marketplace-ui is the only system app that's also an OCI-published app from this repo. Other system apps (Traefik, cert-manager, etc.) reference external OCI charts.
- Reflector already deployed — cross-namespace secret copy of `user-apps-source-auth` from `gogs` namespace to marketplace-ui namespace is automatic once the namespace exists.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-containerization-deployment*
*Context gathered: 2026-04-29*
