# QA — Jellyfin e2e on librepod-dev (t_9740ee54)

**Date:** 2026-10-20 (MSK) · **Cluster:** librepod-dev (k3s v1.34.3, single node Ready)
**Kubeconfig:** the live dev kubeconfig on this host (the skill's `librepod-dev.config` filename doesn't exist here; the active config pointing at the dev cluster was used — same cluster the prior marketplace-app verifications ran on)
**Reviewed build:** commit 85ed442 (PR #293, branch claude/t_1e0e45b1/20261020093456, merged → sdlc/t_ce5a705b as ca7cf53)

## Artifact chain (what was actually tested)

- PR #293 targets `sdlc/t_ce5a705b` (stacked on #292 → master), so its own pushes never ran publish-apps CI. The stack-root PR #292 (pull_request→master, paths apps/jellyfin/**) did — the merge of #293 into the stack branch at 11:20Z published the artifact.
- Tested tag: **`pr-292`** — only jellyfin tag on GHCR (`ghcr.io/librepod/marketplace/apps/jellyfin`).
- Artifact annotations: revision `2d2dbb2` (merge commit of #293 into stack branch), created 2026-10-20T11:20:44Z.
- **Content equivalence verified:** `git ls-tree -r` blob hashes of apps/jellyfin at the artifact revision (2d2dbb2) and the reviewed commit (85ed442) are IDENTICAL — the artifact ships exactly what was reviewed and approved.
- Runtime image: `jellyfin/jellyfin:12.2` (per Deployment; confirms metadata version).

## Pipeline

| Stage | Result |
|---|---|
| 1 RESOLVE (metadata from PR branch, tag pr-292) | ok — no secrets/settings/OpenBao deps (zero-secret app) |
| 3 RENDER (render-templates.py, BASE_DOMAIN=libre.pod) | ok — source.yaml/release.yaml/kustomization.yaml |
| 4 COMMIT (Gogs user-apps via port-forward 3999) | ok — commit `040390c` "test: add jellyfin (tag: pr-292, QA t_9740ee54)" |
| 5 RECONCILE (flux reconcile user-apps --with-source) | ok — fetched 040390c, applied, **marketplace-jellyfin READY=True** @ pr-292@sha256:d02fffbd (~70s) |
| 6 VERIFY (verify-app.sh, 10/10) | **PASS** |
| 8 CLEANUP | deferred — see "Cleanup" |

## Verification detail (Stage 6, verify-app.sh: 10 passed / 0 failed / 0 warnings)

| Check | Status | Evidence |
|---|---|---|
| Flux Kustomization | PASS | `marketplace-jellyfin  pr-292@sha256:d02fffbd  READY=True  Applied revision: pr-292@sha256:d02fffbd` |
| OCIRepository | PASS | artifact pulled, digest sha256:d02fffbd… |
| Pod Health | PASS | `jellyfin-746ff9cf7d-8kfbn  1/1  Running  0 restarts` |
| Restarts / Probes | PASS | 0 restarts; all probes passing, pod Ready |
| HTTP Endpoint | PASS | HTTP 302 → `https://jellyfin.libre.pod/web/` |
| Log Inspection | PASS | 0 error entries; startup complete in 13.6s: `Startup complete 0:00:13.5562014`, `ServerId: db66177a56bc4d899af75c0f65a038e7`, ffmpeg 8.1.3 detected |
| PVCs | PASS | 3/3 Bound on nfs-client: `jellyfin-config 1Gi`, `jellyfin-media 100Gi`, `jellyfin-cache 10Gi` (all RWO) |
| Endpoints | PASS | svc/jellyfin ClusterIP :80 → pod :8096 |
| Resources | PASS | 2 ConfigMaps, 0 Secrets |

## IngressRoute + UI evidence

- IngressRoute match: `Host(\`jellyfin.libre.pod\`)` → svc jellyfin:80, priority 1. No SSO middleware (by design, spec ruling).
- TLS: wildcard cert `CN=*.libre.pod`, SANs `*.libre.pod, libre.pod` (cert-manager).
- `curl -sL https://jellyfin.libre.pod/` → 200, 5441 bytes, `<title>Jellyfin</title>` — web UI loads.
- Anonymous API: `GET /System/Info/Public` → 200 JSON: `Version: 12.2.0`, `ProductName: Jellyfin Server`, `StartupWizardCompleted: false` (fresh install, wizard pending — expected for a brand-new deployment).

## Environment deviations from skill defaults (not app defects)

- Kubeconfig name: config-beelink (no librepod-dev.config on this host).
- BASE_DOMAIN: libre.pod (cluster wildcard), not the skill's doc default librepod.dev.
- `jq` was missing → first verify-app.sh run reported false FAILs (empty JSON parsing); installed jq 1.7 and re-ran clean 10/10. Skill prerequisite worth adding to the doc.

## Verdict

**PASS.** Jellyfin 12.2 deploys end-to-end from the PR's published OCI artifact (tag pr-292, content-identical to reviewed 85ed442): Flux healthy, pod Running with 0 restarts, 3 PVCs bound on nfs-client, IngressRoute serving the real hostname with valid TLS, web UI loads, public API reports 12.2.0. App remains installed on dev for Alex's hands-on final acceptance at **https://jellyfin.libre.pod/**.

## Cleanup

App intentionally LEFT RUNNING on librepod-dev for Alex's acceptance. To revert after acceptance:
`git -C <user-apps-clone> rm -r apps/jellyfin && commit && push`, then `flux reconcile kustomization user-apps --with-source`; NFS folders under the three PVC export paths persist unless wiped (capture PV paths before pruning).
