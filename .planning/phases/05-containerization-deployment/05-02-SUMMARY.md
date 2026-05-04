---
phase: 05-containerization-deployment
plan: 02
subsystem: infra
tags: [kubernetes, kustomize, fluxcd, traefik, rbac, configmap, oci-artifact]

# Dependency graph
requires:
  - phase: 01-backend-foundation-catalog-api
    provides: CatalogService with CATALOG_PATH env var and fs.watch hot-reload
  - phase: 03-installed-apps-live-status
    provides: ServiceAccount + RBAC design for FluxCD CRD reads, GogsService env vars
  - phase: 05-containerization-deployment/05-01
    provides: Dockerfile and ServeStaticModule wiring in app.module.ts
provides:
  - Complete K8s manifest structure at apps/marketplace-ui/ (base + overlay)
  - Namespace, ServiceAccount+RBAC, ConfigMap, Deployment, Service in base/
  - IngressRoute in overlay WITHOUT OAuth middleware (DEPL-03)
  - ConfigMapGenerator embedding catalog.yaml into the container
  - SecretGenerator with Reflector annotation for Gogs auth
  - metadata.yaml for CI workflow discovery
affects: [05-03 bootstrap integration, CI workflow]

# Tech tracking
tech-stack:
  added: []
  patterns: [configMapGenerator-with-disableNameSuffixHash, reflector-pull-secret-annotation, httpGet-probes-on-api-health]

key-files:
  created:
    - apps/marketplace-ui/base/namespace.yaml
    - apps/marketplace-ui/base/serviceaccount.yaml
    - apps/marketplace-ui/base/configmap.yaml
    - apps/marketplace-ui/base/deployment.yaml
    - apps/marketplace-ui/base/service.yaml
    - apps/marketplace-ui/base/kustomization.yaml
    - apps/marketplace-ui/base/catalog.yaml
    - apps/marketplace-ui/overlays/librepod/ingressroute.yaml
    - apps/marketplace-ui/overlays/librepod/kustomization.yaml
    - apps/marketplace-ui/metadata.yaml
  modified: []

key-decisions:
  - "Catalog.yaml copied into base/ directory instead of referencing repo-root path (kustomize security policy blocks external file references)"
  - "No OAuth middleware on IngressRoute per DEPL-03 (open access within local cluster)"

patterns-established:
  - "catalog.yaml embedded via configMapGenerator with disableNameSuffixHash for stable volume mount names"
  - "Gogs auth via Reflector pull-pattern: secretGenerator with reflects annotation targeting gogs/user-apps-source-auth"
  - "httpGet probes on /api/health instead of tcpSocket (leverages existing health endpoint)"

requirements-completed: [DEPL-01, DEPL-03]

# Metrics
duration: 4min
completed: 2026-05-04
---

# Phase 5 Plan 02: K8s Manifests Summary

**Complete Kubernetes manifest structure for marketplace-ui as a system app -- namespace, RBAC, catalog ConfigMap, Deployment with health probes, ClusterIP Service, and Traefik IngressRoute without auth**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-04T12:43:41Z
- **Completed:** 2026-05-04T12:47:33Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- All base K8s manifests following whoami/vaultwarden patterns: Namespace, ServiceAccount+ClusterRole+ClusterRoleBinding, ConfigMap, Deployment, Service
- Overlay with Traefik IngressRoute at marketplace.${BASE_DOMAIN} with TLS and no OAuth middleware
- catalog.yaml embedded via configMapGenerator for hot-reload compatibility
- Gogs auth secret via Reflector pull-pattern for cross-namespace secret replication
- metadata.yaml for CI workflow app discovery

## Task Commits

Each task was committed atomically:

1. **Task 1: Create base manifests** - `9ccb79a` (feat)
2. **Task 2: Create overlay and metadata** - `c7253da` (feat)

## Files Created/Modified
- `apps/marketplace-ui/base/namespace.yaml` - Namespace definition for marketplace-ui
- `apps/marketplace-ui/base/serviceaccount.yaml` - ServiceAccount + ClusterRole (FluxCD CRD reads) + ClusterRoleBinding
- `apps/marketplace-ui/base/configmap.yaml` - Env vars: PORT, CATALOG_PATH, GOGS_URL, ALLOWED_ORIGIN
- `apps/marketplace-ui/base/deployment.yaml` - Deployment with catalog volume mount, GOGS_TOKEN secret, health probes, resource limits
- `apps/marketplace-ui/base/service.yaml` - ClusterIP Service port 80 -> targetPort http
- `apps/marketplace-ui/base/kustomization.yaml` - Base kustomization with configMapGenerator (catalog) and secretGenerator (gogs-auth)
- `apps/marketplace-ui/base/catalog.yaml` - Copy of catalog.yaml for configMapGenerator
- `apps/marketplace-ui/overlays/librepod/ingressroute.yaml` - Traefik IngressRoute with TLS, no middleware
- `apps/marketplace-ui/overlays/librepod/kustomization.yaml` - Overlay referencing base + ingressroute
- `apps/marketplace-ui/metadata.yaml` - AppDefinition metadata for CI workflow discovery

## Decisions Made
- Catalog.yaml copied into base/ directory instead of using relative path `../../../catalog.yaml` -- kustomize's security policy rejects file references outside the kustomization directory. The copy will be packaged into the OCI artifact by flux push artifact, which captures the entire apps/marketplace-ui/ directory.
- No OAuth middleware on IngressRoute per DEPL-03 -- open access within local cluster network is by design.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] catalog.yaml configMapGenerator path rejected by kustomize**
- **Found during:** Task 1 (base manifests creation)
- **Issue:** Plan specified `catalog.yaml=../../../catalog.yaml` in configMapGenerator, but kustomize blocks file references outside the kustomization root directory with error "security; file is not in or below"
- **Fix:** Copied catalog.yaml into `apps/marketplace-ui/base/` and changed the configMapGenerator entry to `- catalog.yaml` (local file reference)
- **Files modified:** `apps/marketplace-ui/base/catalog.yaml` (new copy), `apps/marketplace-ui/base/kustomization.yaml` (path fix)
- **Verification:** `kustomize build apps/marketplace-ui/base/` exits 0 with all 8 resources
- **Committed in:** `9ccb79a` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minimal -- the catalog.yaml copy is functionally equivalent and will be packaged into the OCI artifact. Future updates to catalog.yaml at repo root will need to be copied into the base directory as well (or automated via CI).

## Issues Encountered
None beyond the kustomize security policy deviation documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All K8s manifests ready for Plan 05-03 (bootstrap integration)
- Plan 05-03 needs to create `infrastructure/system-apps/marketplace-ui.yaml` (OCIRepository + FluxCD Kustomization with dependsOn)
- Plan 05-03 needs to add marketplace-ui to `infrastructure/system-apps/kustomization.yaml` resources list
- Plan 05-03 needs to handle CI workflow for Docker image build + OCI artifact push

## Self-Check: PASSED

- All 10 created files verified present on disk
- Both task commits verified in git log (9ccb79a, c7253da)

---
*Phase: 05-containerization-deployment*
*Completed: 2026-05-04*
