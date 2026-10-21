# Spec — Optio marketplace app (t_f2f1ec69)

Parent intent: `sdlc/t_06dfb637/intent.md` (same branch). All chart behavior
below was verified against the real chart 0.18.1 sources (pulled from
`oci://ghcr.io/jonwiggins/optio`, digest
`sha256:ad9e7b2da5a9dc8815131aeb8faa7eed5f51ab9989907a19dc6c7c35efed12b5`).
Upstream: https://github.com/jonwiggins/optio (MIT). Helm-type app.
Chart 0.18.1 = appVersion 0.18.1 (lockstep); `optio-api`/`optio-web` publish
matching `0.18.1` image tags on GHCR (verified via registry tags API).
`kubeVersion: '>=1.33.0-0'` — dev (k3s v1.34.3) OK; prod gate in O4.

## 0. Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | App name / namespace | `optio` |
| D2 | Chart source | `oci://ghcr.io/jonwiggins/optio`, OCIRepository `ref.tag: "0.18.1"` (exact pin) |
| D3 | HelmRelease → chart | `chartRef: {kind: OCIRepository, name: optio-helm-charts}` — repo convention (casdoor/immich shape) |
| D4 | spec.version | `0.18.1`; no renovate annotation — hand-coupled to the chart pin |
| D5 | Release name | `releaseName: optio` → resources `optio-api`, `optio-web`, `optio-postgres`, `optio-redis`; Secrets `optio-config`, `optio-postgres-credentials`, `optio-redis-auth`, `optio-redis-tls`, `optio-postgres-tls` |
| D6 | Routing | Traefik IngressRoute `optio`, four rules on Host(`optio.${BASE_DOMAIN:=libre.pod}`) — see §5. No Strip middleware anywhere (Optio's routes are root-relative). Chart ingress/gatewayAPI disabled. |
| D7 | Generated secrets | `OPTIO_ENCRYPTION_KEY` (hex 32) and `DB_PASSWORD` (length 40) — OpenBao generate, delivered via HelmRelease `valuesFrom` (§3). valuesFrom (not `existingSecrets.DATABASE_URL`) is the only coherent carrier: the chart requires `postgresql.auth.password` at render regardless, and it bakes the SAME value into both `optio-postgres-credentials` (postgres container) and the `DATABASE_URL` in `optio-config` (api) — one value, all consumers consistent |
| D8 | SSO mode | Native OIDC. SSOClient `optio-sso` per §6 |
| D9 | Issuer | Bare issuer `https://id.${BASE_DOMAIN:=libre.pod}` in `auth.oidc.issuerUrl` (Flux substitute). Optio appends `/.well-known/openid-configuration` itself, so the controller's full-discovery issuer key must NOT be wired to OIDC_ISSUER_URL |
| D10 | OIDC creds | chart `existingSecrets` → `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` from Secret `optio-sso`. Chart renders OIDC env only when `auth.oidc.issuerUrl` is non-empty (secrets.yaml gates on it) — guaranteed by D9 |
| D11 | CA trust | Chart has NO init-container hook and NO literal-env hook on the api pod (verified: only `api.extraVolumes`/`extraVolumeMounts` + `existingSecrets`). Adapted §4 pattern: mount Secret `step-certificates-certs` at `/etc/step-ca` (NOT under `/etc/optio` — the chart's pg-ca volume already owns `/etc/optio`; two volumes cannot share a mountPath). Env `NODE_EXTRA_CA_CERTS=/etc/step-ca/root_ca.crt` from a committed plain Secret `optio-ca-env` via `existingSecrets` — the value is a public filesystem path, not a credential; a committed Secret (not ConfigMap) because the chart's hook consumes Secrets only. NODE_EXTRA_CA_CERTS is additive in Node, so public TLS keeps working. `SSL_CERT_FILE` NOT set (api+web are both Node). |
| D12 | `/api/internal` blocking | Chart's nginx ingress 404s `/api/internal/*` (bearer-token endpoints stay cluster-internal). Our IngressRoute replicates with a dedicated rule matching `/api/internal` that has NO service → Traefik 404. Explicit priorities ensure it wins over `/api` (§5) |
| D13 | Postgres | Chart-bundled Postgres 16 on nfs-client (upstream's `init-data-perms` initContainer chowns 999:999 — NFS-safe). Password via valuesFrom (D7). Postgres TLS on (chart default, chart-internal CA; nothing for us to wire) |
| D14 | converge-db-password | N/A — chart-owned postgres Deployment, no sidecar hook. NFS-rebind drift covered by stored-beats-default settings resolution (reinstall reuses the stored OpenBao value). Residual risk flagged O5 |
| D15 | Redis | Chart defaults (TLS+auth on, ephemeral, no PVC) |
| D16 | RBAC | `rbac.clusterRole.create: false` — least privilege; cost: cluster overview loses node utilization. O1 |
| D17 | resourceQuota | `false` for v1 — chart defaults exceed consumer hardware; wrong-small guess blocks agent pods Pending. O2 |
| D18 | Assistant pod | `optio.enabled: false` (chart default). O3 |
| D19 | Agent storage | `agent.pvc.storageClass: nfs-client`, `agent.cache.storageClass: nfs-client`; sizes = chart defaults. Agent images float `:latest` by upstream design (runtime-pulled by the API) |
| D20 | Image pins | `api.image.tag: "0.18.1"`, `web.image.tag: "0.18.1"` — chart defaults float on `:latest`; pinning keeps deployed == advertised. Envoy/agent images keep chart defaults |
| D21 | publicUrl | `https://optio.${BASE_DOMAIN:=libre.pod}` — chart hard-fails render without it (auth enabled) |
| D22 | Namespace ownership | Chart renders its own Namespace (unconditional template) — drop our `base/namespace.yaml`, chart is the single writer. Kustomize `namespace: optio` still set (base+overlay) so kustomize-rendered resources land in ns optio. HelmRelease has NO targetNamespace — chart places resources via `.Values.namespace` (casdoor precedent). No `base/pvc.yaml`, no `patch-storage-class.yaml` — all PVCs chart-rendered, storageClass via values |

## 1. File inventory (authoritative)

```
apps/optio/
├── metadata.yaml
├── base/
│   ├── kustomization.yaml        # namespace optio; labels; resources below
│   ├── ocirepository.yaml        # optio-helm-charts @ 0.18.1
│   ├── helmrelease.yaml          # chartRef, RetryOnFailure, valuesFrom ×2
│   └── externalsecret.yaml       # optio-settings ← OpenBao apps/optio
└── overlays/librepod/
    ├── kustomization.yaml        # resources: ../../base + ingressroute, ssoclient,
    │                             #   externalsecret-ca, optio-ca-env secret; patch-helmrelease
    ├── patch-helmrelease.yaml    # LibrePod values (§4)
    ├── ingressroute.yaml         # 4 rules (§5)
    ├── ssoclient.yaml            # optio-sso (§6)
    ├── externalsecret-ca.yaml    # step-certificates-certs ← apps/step-ca (guide §4(1))
    └── secret-ca-env.yaml        # plain Secret optio-ca-env (D11)
```

Settings ExternalSecret in base (skill contract: `<app>-settings`); CA
ExternalSecret in overlay (guide §4(1)). Standard `dataFrom.extract` form,
key `apps/optio`, target `optio-settings`, refreshInterval 5m, ClusterSecretStore
`openbao`.

## 2. base/ocirepository.yaml

```yaml
apiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: optio-helm-charts
spec:
  interval: 24h
  url: oci://ghcr.io/jonwiggins/optio
  ref:
    tag: "0.18.1"
```

## 3. base/helmrelease.yaml

Structure (plan carries exact YAML):

- `releaseName: optio`, `interval: 12h`
- `install: {strategy: {name: RetryOnFailure}, retryInterval: 2m}`
- `upgrade: {strategy: {name: RetryOnFailure}, retryInterval: 3m}`
- `chartRef: {kind: OCIRepository, name: optio-helm-charts}`
- no targetNamespace (D22)
- `valuesFrom` exactly two entries:

```yaml
valuesFrom:
- kind: Secret
  name: optio-settings
  valuesKey: OPTIO_ENCRYPTION_KEY
  targetPath: encryption.key
- kind: Secret
  name: optio-settings
  valuesKey: DB_PASSWORD
  targetPath: postgresql.auth.password
```

Ordering: `postgresql.auth.password` is required at helm render time; helm-controller
resolves valuesFrom before render. If optio-settings is not synced yet, the
HelmRelease retries (RetryOnFailure + reconcile interval) — self-healing. On
marketplace installs, marketplace-ui writes the OpenBao entry before creating
the HelmRelease; on dev, seed OpenBao first (§8.2).

## 4. overlays/librepod/patch-helmrelease.yaml — values

```yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: optio
spec:
  values:
    namespace: optio
    publicUrl: https://optio.${BASE_DOMAIN:=libre.pod}
    auth:
      oidc:
        issuerUrl: https://id.${BASE_DOMAIN:=libre.pod}
        displayName: "LibrePod SSO"
        # clientId/clientSecret deliberately empty — creds arrive via
        # existingSecrets; the chart gates OIDC env on issuerUrl only
    existingSecrets:
      OIDC_CLIENT_ID:
        name: optio-sso
        key: OIDC_CLIENT_ID
      OIDC_CLIENT_SECRET:
        name: optio-sso
        key: OIDC_CLIENT_SECRET
      NODE_EXTRA_CA_CERTS:
        name: optio-ca-env
        key: NODE_EXTRA_CA_CERTS
    api:
      image:
        tag: "0.18.1"
      extraVolumes:
        - name: step-ca
          secret:
            secretName: step-certificates-certs
            defaultMode: 420
            items:
              - key: root_ca.crt
                path: root_ca.crt
              - key: intermediate_ca.crt
                path: intermediate_ca.crt   # present in the Secret; mounted as
                                            # fallback if the chain needs it
      extraVolumeMounts:
        - name: step-ca
          mountPath: /etc/step-ca
          readOnly: true
    web:
      image:
        tag: "0.18.1"
    postgresql:
      storage:
        storageClass: nfs-client
    agent:
      pvc:
        storageClass: nfs-client
      cache:
        storageClass: nfs-client
    rbac:
      clusterRole:
        create: false
    ingress:
      enabled: false
    gatewayAPI:
      enabled: false
    resourceQuota:
      enabled: false
    optio:
      enabled: false
```

CA fallback (only if QA §8.4 shows the chain needs the intermediate): ESO can
merge both CAs into one file without any init container — in
`externalsecret-ca.yaml` add `target.template.data` mapping
`ca-bundle.crt: "{{ .root_ca.crt }}{{ .intermediate_ca.crt }}"` (keeping the
two original keys), and point `optio-ca-env`'s value at `/etc/step-ca/ca-bundle.crt`
(mount it via `items` too). Default stays root-only for parity with the guide's
identical-per-app externalsecret-ca.yaml.

## 5. overlays/librepod/ingressroute.yaml

Single IngressRoute `optio`, entryPoints web+websecure, Host
`optio.${BASE_DOMAIN:=libre.pod}`. Four rules, explicit priorities
(longest path = highest so `/api/internal` beats `/api` beats `/ws` beats `/`):

| # | Match (in addition to Host) | priority | services |
|---|------------------------------|----------|----------|
| 1 | `PathPrefix(\`/api/internal\`)` | 400 | NONE — rule exists only to 404 the path (D12) |
| 2 | `PathPrefix(\`/api\`)` | 300 | `optio-api` :4000 |
| 3 | `PathPrefix(\`/ws\`)` | 200 | `optio-api` :4000 (ws upgrade automatic in Traefik) |
| 4 | `PathPrefix(\`/\`)` | 100 | `optio-web` :3000 |

No middlewares on any rule (native OIDC — the app authenticates itself).
No launch annotation (front door is `/` → web).

Rule 1 fallback: if Traefik rejects a serviceless rule at apply time, replace
it with `services: [{name: api@internal, kind: TraefikService}]` — Traefik's
internal 404 handler, same external behavior (the chart's nginx snippet is
`return 404`). Plan tries the serviceless form first only if `helm template`
`--validate` is available; QA gate §8.4 catches it live either way.

## 6. overlays/librepod/ssoclient.yaml

```yaml
apiVersion: marketplace.librepod.org/v1alpha1
kind: SSOClient
metadata:
  name: optio-sso
  namespace: optio
spec:
  clientId: optio
  organization: librepod
  redirectUris:
    - "https://optio.${BASE_DOMAIN}/api/auth/oidc/callback"
  grantTypes: [authorization_code, refresh_token]
  tokenFormat: JWT-Standard
  expireInHours: 168
  output:
    secretName: optio-sso
    keys:
      clientId: OIDC_CLIENT_ID
      clientSecret: OIDC_CLIENT_SECRET
      issuer: OIDC_ISSUER_DISCOVERY   # written but unused by optio (D9)
  casdoorPolicy: retain
```

## 7. metadata.yaml

- `displayName: "Optio"`; description: "Self-hosted AI coding agent orchestration — work feed, scheduled and event-triggered agent runs, live sessions"
- `icon: https://raw.githubusercontent.com/jonwiggins/optio/main/apps/site/public/optio-mark.svg`
- `category: "AI"`; `website: https://github.com/jonwiggins/optio`; `version: "0.18.1"`
- `source: {type: oci-kustomize, url: oci://ghcr.io/librepod/marketplace/apps/optio, path: ./overlays/librepod}`
- settings — two generated items only (all-generate ⇒ one-click install, dialog never opens):

```yaml
settings:
  items:
    - name: OPTIO_ENCRYPTION_KEY
      label: "Encryption key"
      description: "Encrypts stored credentials (agent API keys, tokens). Generated automatically."
      sensitive: true
      generate:
        length: 32
    - name: DB_PASSWORD
      label: "Database password"
      description: "PostgreSQL password, shared by optio and its bundled database. Generated automatically."
      sensitive: true
      generate:
        length: 40
```

`NODE_EXTRA_CA_CERTS` is NOT a settings item — it is a committed constant in
`optio-ca-env` (D11). `allowCustom` omitted (closed) — the chart has no
extraEnvFrom hook, so free-form custom env vars would never reach the app.

- templates.release `dependsOn`:

```yaml
dependsOn:
- name: storage
- name: traefik
- name: casdoor-sso-controller
```

`casdoor-sso-controller` (the Flux Kustomization carrying CRD + controller),
NOT bare `casdoor` — sso-app-author-guide §3 wins over older metadata files.

- `dependencies.required`: IngressController (traefik), StorageClass (nfs-client,
  nfs-provisioner app), SSOProvider (Casdoor + casdoor-sso-controller →
  Secret/optio-sso).
- templates.source / kustomization: standard (marketplace-optio OCIRepository +
  Kustomization, postBuild.substitute BASE_DOMAIN).

## 8. Verification gates (build/QA)

On librepod-dev (`~/.kube/config`, context `beelink` — the skill's
`~/.kube/librepod-dev.config` does not exist on this machine):

1. Render gates (no cluster):
   - `helm template optio <chart> --version 0.18.1` with the §4 values
     (BASE_DOMAIN → librepod.dev; `--set-string encryption.key=<dev-hex>
     postgresql.auth.password=<dev-pw>` standing in for valuesFrom): assert
     OIDC_CLIENT_ID/SECRET + NODE_EXTRA_CA_CERTS env present as secretKeyRefs;
     step-ca volume at /etc/step-ca; no Ingress/Gateway resources; no
     ClusterRole/ClusterRoleBinding; OPTIO_HOME_PVC_STORAGE_CLASS=nfs-client and
     OPTIO_CACHE_STORAGE_CLASS=nfs-client in the config Secret; image tags
     `0.18.1` on api+web; publicUrl + OIDC issuer rendered.
   - `kustomize build` base and overlay + sed BASE_DOMAIN → librepod.dev:
     no residual `${...}` placeholders.
2. Seed OpenBao `apps/optio` (OPTIO_ENCRYPTION_KEY, DB_PASSWORD) with the root
   token from `Secret/openbao-credentials` (n openbao) — else the HelmRelease
   blocks on the chart's required-password render gate until ESO syncs.
3. Apply kustomize output; HelmRelease Ready; pods Running (api+web, postgres,
   redis); postgres PVC Bound on nfs-client.
4. e2e: `https://optio.librepod.dev` serves web; `/api/health` answers via rule 2;
   `/api/internal/anything` returns 404 from the edge (D12 gate); OIDC discovery
   from inside the api pod succeeds with the mounted CA (wget
   --ca-certificate=/etc/step-ca/root_ca.crt
   https://id.librepod.dev/.well-known/openid-configuration).
5. SSO live: SSOClient Phase=Ready; Secret optio-sso has 3 keys; browser login
   via Casdoor lands on the callback and completes.
6. Cleanup: ask Alex before deleting the namespace.

## 9. Open questions → PR concerns (do not block)

- O1 `rbac.clusterRole.create=false` recommended (D16) — Alex may prefer cluster overview.
- O2 `resourceQuota.enabled=false` for v1 (D17) — Alex decides agent-pod capping.
- O3 Assistant pod off (D18); agent runtime images float `:latest` by upstream design (D19).
- O4 Production devices' k3s must be verified >=1.33 before release (kubeVersion gate) — blocks release, not this PR.
- O5 No converge-db-password possible on chart-owned postgres (D14); stored-beats-default covers reinstalls; manual OpenBao divergence remains — user-guide troubleshooting entry.
- O6 `JWT-Standard` token format (guide's strict-client trap; Optio's Node client is lenient, belt and braces).
- O7 OIDC button label "LibrePod SSO" (auth.oidc.displayName).
- O8 Icon URL tracks upstream `main` — if moved, icon 404s; acceptable.
- O9 First-admin bootstrap: first OIDC sign-in + one-time setup token from API log (chart NOTES) — document in user-guide; not automated in v1.
- O10 `casdoorPolicy: retain`; secret rotation via `marketplace.librepod.org/rotate-secret=true` annotation.
