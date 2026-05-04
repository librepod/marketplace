---
phase: 05-containerization-deployment
plan: 03
subsystem: infra
tags: [fluxcd, ocirepository, kustomization, github-actions, cosign, docker, ci-cd]

# Dependency graph
requires:
  - phase: 05-02
    provides: "K8s manifests for marketplace-ui app (Deployment, Service, IngressRoute, etc.)"
provides:
  - "FluxCD OCIRepository + Kustomization for marketplace-ui as system app"
  - "CI workflow for Docker image build + OCI artifact push + Cosign signing"
  - "marketplace-ui wired into system-apps bootstrap chain"
affects: [deployment, bootstrap, ci-cd]

# Tech tracking
tech-stack:
  added: []
  patterns: [fluxcd-ocirepository-system-app, ci-workflow-dual-artifact]

key-files:
  created:
    - infrastructure/system-apps/marketplace-ui.yaml
    - .github/workflows/publish-marketplace-ui.yaml
  modified:
    - infrastructure/system-apps/kustomization.yaml

key-decisions:
  - "marketplace-ui depends on gogs and cert-manager only (not oauth2-proxy per DEPL-03)"
  - "Separate CI workflow instead of extending publish-apps.yaml (Docker build is fundamentally different)"

patterns-established:
  - "Dual-artifact CI: one job for Docker image, one for OCI Kustomize manifests, both Cosign-signed"

requirements-completed: [DEPL-01]

# Metrics
duration: 3min
completed: 2026-05-04
---

# Phase 5 Plan 03: FluxCD Bootstrap Integration & CI Workflow Summary

**FluxCD Kustomization wiring marketplace-ui into system-apps with dependsOn gogs+cert-manager, plus parallel CI workflow for Docker image and OCI artifact publishing with Cosign signing**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-04T12:51:34Z
- **Completed:** 2026-05-04T12:54:24Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created FluxCD OCIRepository + Kustomization for marketplace-ui with Cosign verification
- Wired marketplace-ui into system-apps bootstrap dependency chain (after gogs and cert-manager)
- Created CI workflow with parallel Docker image build and OCI manifest artifact push, both Cosign-signed

## Task Commits

Each task was committed atomically:

1. **Task 1: Create FluxCD Kustomization for marketplace-ui and wire into system-apps** - `5dcdc73` (feat)
2. **Task 2: Create CI workflow for Docker image build + OCI artifact push + Cosign signing** - `278a618` (feat)

## Files Created/Modified
- `infrastructure/system-apps/marketplace-ui.yaml` - OCIRepository + FluxCD Kustomization with dependsOn gogs, cert-manager
- `infrastructure/system-apps/kustomization.yaml` - Added marketplace-ui.yaml to system-apps resources list
- `.github/workflows/publish-marketplace-ui.yaml` - CI workflow: publish-image job (Docker build+push+sign) and publish-manifests job (flux push artifact+sign)

## Decisions Made
- Used separate CI workflow (not extending publish-apps.yaml) because the Docker build step is fundamentally different from manifest-only OCI artifact push. This keeps publish-apps.yaml clean for other apps.
- dependsOn lists only gogs and cert-manager, not oauth2-proxy, consistent with DEPL-03 (no auth required).
- Cluster system-apps files (librepod-dev, librepod) needed no changes -- they reference `./infrastructure/system-apps` as a path, so adding marketplace-ui.yaml to the infrastructure kustomization is sufficient.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- marketplace-ui is now fully integrated into the FluxCD bootstrap chain
- CI workflow will build Docker image + push OCI manifests + sign both on push to master
- Combined with Plans 01 (K8s manifests) and 02 (Dockerfile + serve-static), the full deployment pipeline is complete

---
*Phase: 05-containerization-deployment*
*Completed: 2026-05-04*
