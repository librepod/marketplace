---
card: t_06dfb637
stage: intent
status: accepted
app: optio
created: 2026-10-20
accepted: 2026-10-21
next: sdlc/t_06dfb637/spec.md (card t_f2f1ec69)
---

# Intent: add Optio to the LibrePod Marketplace

Requested by: Alex (maintainer), 2026-10-20. Card authored by Alex with
full upstream research; promoted triage→ready by Alex 2026-10-20 21:09
UTC (acceptance — see "Acceptance" below).

## Problem

Users want self-hosted orchestration for AI coding agents (Claude Code,
Codex, Copilot, Gemini, Cursor, OpenCode…). Optio
(https://github.com/jonwiggins/optio, MIT) provides exactly this: work
feed, scheduled/repo/event-triggered agent runs, sessions with terminals,
native iOS/Android apps. It should be installable from the marketplace
like any other app.

## Outcome

`apps/optio/` in the marketplace repo, published as an OCI artifact,
installable one-click from marketplace-ui, with LibrePod SSO (Casdoor
OIDC) and NFS-backed storage.

## Research (2026-10-20, chart 0.18.1)

- **Upstream**: jonwiggins/optio, latest release v0.18.1 (2026-10-18).
  TypeScript/Next.js/Fastify + PostgreSQL + Redis + K8s. Agent pods run
  as StatefulSets/Jobs created at runtime by the API server.
- **Chart**: `oci://ghcr.io/jonwiggins/optio` — chart **0.18.1** =
  appVersion **0.18.1** (lockstep versioning). `kubeVersion: >=1.33.0` —
  dev cluster (beelink k3s v1.34.3) is fine; production devices' k3s
  version must be verified ≥1.33 before release.
- **Topology**: api+web share ONE pod (Recreate, migrations at boot,
  startupProbe 60×10s). Built-in Postgres 16 Deployment (PVC, runAs 999 +
  init-perms initContainer — NFS-compatible, handles chown itself) with
  self-signed TLS; built-in Redis 7 (TLS + auth, no PVC — ephemeral by
  design, only Postgres persists). Services: `optio-api:4000`
  (appProtocol ws), `optio-web:3000`. Ingress path split: `/`→web,
  `/api`+`/ws`→api. We replace chart ingress (nginx) with a Traefik
  IngressRoute — 3 PathPrefix rules, no strip.
- **Required secrets**: `encryption.key` (REQUIRED, openssl rand -hex 32),
  `postgresql.auth.password` (REQUIRED, rendered into chart Secret
  `{release}-postgres-credentials`), publicUrl (REQUIRED when auth
  enabled).
- **Secret injection**: chart supports `existingSecrets: {ENV: {name,
  key}}` → env vars from arbitrary Secrets (this is the hook for OIDC
  creds). HelmRelease `valuesFrom.targetPath` can feed
  `postgresql.auth.password` / `encryption.key` from the settings Secret
  (ESO/OpenBao) — no literals in git.
- **SSO**: native generic OIDC (`OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` +
  `OIDC_CLIENT_SECRET` env; provider enabled automatically when issuer
  set). Callback: `{PUBLIC_URL}/api/auth/oidc/callback` →
  `https://optio.${BASE_DOMAIN}/api/auth/oidc/callback`. Two quirks for
  spec:
  1. Optio appends `/.well-known/openid-configuration` itself
     (oidc.ts:42) → it needs the **bare issuer** `https://id.${BASE_DOMAIN}`
     — but the casdoor-sso-controller writes the **full discovery URL**
     into its Secret's issuer key. So take only client id/secret from the
     SSOClient Secret via existingSecrets; set `auth.oidc.issuerUrl` via
     Flux substitute in the HelmRelease values.
  2. Chart has **no extraEnv hook** on the api container (only
     extraVolumes/extraVolumeMounts). Node.js needs `NODE_EXTRA_CA_CERTS`
     for the private Step CA → deliverable via existingSecrets from the
     settings Secret (value = merged-bundle path), volumes via
     `api.extraVolumes/extraVolumeMounts` + init container per
     docs/sso-app-author-guide.md §4 (immich/open-webui pattern).
- **First-admin bootstrap**: with env OIDC configured, first user to sign
  in via OIDC still needs deployment-admin claim via one-time setup token
  (`OPTIO_SETUP_TOKEN` or grepped from API log) — document in app
  notes/user-guide.
- **RBAC**: namespaced Role (pods/secrets/pvc/services/statefulsets/jobs)
  + optional ClusterRole (nodes/namespaces read for cluster overview,
  `rbac.clusterRole.create`). Chart also creates its own Namespace
  resource from `namespace:` value — coordinate with our
  base/namespace.yaml (collision risk: chart template renders Namespace
  too).
- **Agent runtime images**:
  `ghcr.io/jonwiggins/optio-agent-{base,node,python,go,rust,full}`
  pulled on demand; agent PVCs (10Gi default) + cache PVCs created
  dynamically — set `agent.pvc.storageClass` / `agent.cache.storageClass`
  to nfs-client.
- **Icon**:
  https://raw.githubusercontent.com/jonwiggins/optio/main/apps/site/public/optio-mark.svg

## Constraints

- Helm-type app per librepod-app skill; chart version pinned EXACTLY
  (0.18.1); spec.version = baked appVersion.
- No literals for secrets in git — settings (OPTIO_ENCRYPTION_KEY
  generate, DB_PASSWORD generate) via OpenBao + ESO +
  valuesFrom/existingSecrets.
- Branch `sdlc/t_06dfb637`, PR-only, Alex merges.
- Verification on librepod-dev (beelink kubeconfig `~/.kube/config`,
  context `beelink` — skill doc references
  `~/.kube/librepod-dev.config` which does not exist on this machine; dev
  cluster = current context).

## Open questions (ride to PR per async policy, 2026-10-20)

1. `rbac.clusterRole.create`: keep cluster overview (true) or
   least-privilege (false)? **Recommend false** for consumer devices.
2. Production device k3s ≥1.33 confirmation (kubeVersion gate) — blocks
   release, not development.
3. `resourceQuota.enabled`: cap agent pod sprawl on consumer hardware?
   **Recommend true** with chart defaults.
4. Optio assistant pod (`optio.enabled`): keep default **false**.

## Acceptance

Card body authored in full by Alex 2026-10-20 20:32 UTC (research,
constraints, and the note "Open questions ride to PR per async policy;
Alex may also answer here"), then promoted triage→ready by Alex at
21:09 UTC, which released the chain to the dispatcher. Per the
async-only gates policy (2026-10-20), no separate synchronous approval
is required at intent; the single hard gate remains Alex merging the
master PR. Open questions are carried into the PR description.

## Next stage

Spec pass: `sdlc/t_06dfb637/spec.md` (card t_f2f1ec69) — Helm-type app,
chart `oci://ghcr.io/jonwiggins/optio` pinned 0.18.1. Must cover: base
(OCIRepository ref.tag 0.18.1, HelmRelease RetryOnFailure,
externalsecret.yaml for settings), overlay (IngressRoute 3 PathPrefix
rules /→web:3000, /api+/ws→api:4000, no strip, middlewares omitted for
native OIDC; patch-helmrelease with values + chart version pin),
settings (OPTIO_ENCRYPTION_KEY + DB_PASSWORD generated via OpenBao →
valuesFrom targetPath), SSO (SSOClient CR optio-sso +
existingSecrets OIDC_CLIENT_ID/SECRET from controller Secret; bare
issuer `https://id.${BASE_DOMAIN}` via Flux substitute; NODE_EXTRA_CA_CERTS
via existingSecrets + api.extraVolumes CA merge per
sso-app-author-guide §4), namespace collision (chart renders its own
Namespace), rbac.clusterRole.create=false recommendation, agent
pvc/cache storageClass=nfs-client, metadata.yaml AppDefinition. Flag
open questions as PR concerns, do not block.
