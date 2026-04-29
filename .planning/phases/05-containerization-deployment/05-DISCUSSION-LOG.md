# Phase 5: Containerization & Deployment - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-29
**Phase:** 05-containerization-deployment
**Areas discussed:** Docker Build Strategy, K8s Manifest Design, Bootstrap Integration

---

## Docker Build Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Multi-stage + NestJS serves static | Build client+server in stage 1, copy to node:22-alpine in stage 2. NestJS serves static via middleware. | Yes |
| Multi-stage + nginx sidecar | Build as above, nginx serves static + proxies /api to NestJS. | |
| node:22-alpine | Smaller image, full shell for debugging. ~50MB compressed. | Yes |
| distroless | Minimal attack surface, no shell. ~30MB compressed. Harder to debug. | |
| NestJS serves static directly | Single process, single port. Add serve-static middleware to main.ts. | Yes |
| Separate nginx process | Requires supervisor or multi-process container. More complex. | |

**User's choice:** Multi-stage build on node:22-alpine, NestJS serves static files directly
**Notes:** Single container, single process, single port. Simplest approach consistent with PROJECT.md "single container" decision.

---

## K8s Manifest Design

| Option | Description | Selected |
|--------|-------------|----------|
| Standard app structure (base/ + overlay/) | `apps/marketplace-ui/` with base/ and overlays/librepod/. Published as OCI artifact like other apps. | Yes |
| Inline in infrastructure/ | Put manifests directly in infrastructure/system-apps/. Breaks per-app OCI artifact pattern. | |
| Traefik IngressRoute + TLS | Accessible at marketplace.${BASE_DOMAIN} with TLS. Same pattern as all other apps. | Yes |
| Internal only (ClusterIP) | No ingress. Access via port-forward only. No browser access. | |
| ConfigMap mounted as volume | FluxCD syncs catalog.yaml ConfigMap. fs.watch hot-reload picks up changes. | Yes |
| Baked into container image | Copy catalog.yaml into Docker image. Requires rebuild on catalog changes. | |

**User's choice:** Standard app structure, Traefik IngressRoute with TLS, ConfigMap volume mount
**Notes:** Follows established patterns exactly. ConfigMap approach leverages existing fs.watch from Phase 1.

---

## Bootstrap Integration

| Option | Description | Selected |
|--------|-------------|----------|
| Depends on Gogs + cert-manager | Starts after Gogs (needs GOGS_URL) and cert-manager (needs TLS certs). No NFS dependency. | Yes |
| Early start, degrade gracefully | Start after Traefik only. Gogs unreachable = all apps show not_installed. | |
| Dedicated ServiceAccount + read-only ClusterRole | SA with ClusterRole for get/list/watch on FluxCD CRDs. Designed in Phase 3. | Yes |
| Default ServiceAccount (no RBAC) | No custom RBAC. Can't read FluxCD CRDs in other namespaces. Status won't work. | |
| Reuse existing Gogs secret (Reflector) | Use `user-apps-source-auth` secret from gogs namespace, copied by Reflector. | Yes |
| Dedicated Gogs secret | Create a new secret with its own token. More isolation. | |

**User's choice:** Depends on Gogs + cert-manager, dedicated ServiceAccount with ClusterRole, reuse Gogs secret via Reflector
**Notes:** Reflector already deployed as system app. Cross-namespace secret copy is automatic.

---

## Claude's Discretion

- Dockerfile layer caching strategy
- Health probe configuration
- Resource requests/limits values
- ConfigMap update mechanism details
- CI workflow integration (add to existing or new workflow)
- Container image tag strategy

## Deferred Ideas

None — discussion stayed within phase scope
