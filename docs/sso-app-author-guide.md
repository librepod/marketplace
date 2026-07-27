# Adding SSO to a native-OIDC app

The `casdoor-sso-controller` watches `SSOClient` Custom Resources and, for each
one, provisions a Casdoor OIDC Application and writes that app's
`clientId` / `clientSecret` / issuer into a Secret **in the app's own namespace**.
Native-OIDC apps (those that read OIDC config from environment variables) can
therefore get single-sign-on with **zero committed secrets**: the chart reads the
credentials the controller produced at runtime.

This guide shows how to add SSO to a new app. `open-webui` is the reference
implementation — see `apps/open-webui/overlays/librepod/`.

## Prerequisite

The `casdoor-sso` system app must be deployed and healthy:

```bash
kubectl get ssoclient -A                     # CRD installed and controller running
kubectl -n casdoor-sso get deploy casdoor-sso-controller
```

## 1. Add an `SSOClient` CR to your app's overlay

Create `apps/<app>/overlays/librepod/ssoclient.yaml`:

```yaml
apiVersion: marketplace.librepod.org/v1alpha1
kind: SSOClient
metadata:
  name: <app>-sso                # also the default output Secret name
  namespace: <app>
spec:
  clientId: <app>                # becomes the Casdoor app name AND the OIDC client_id
  organization: librepod
  redirectUris:
    - "https://<app>.${BASE_DOMAIN}/oauth/oidc/callback"   # ${BASE_DOMAIN} expanded by Flux AND the controller
  scopes: [openid, profile, email]   # accepted but NOT applied (see Notes); OIDC scopes come from the client auth request
  grantTypes: [authorization_code, refresh_token]
  tokenFormat: JWT-Standard      # see "Token format" below — JWT-Standard, not plain JWT
  expireInHours: 168
  output:
    secretName: <app>-sso        # Secret written into the app namespace
    keys:
      clientId: OAUTH_CLIENT_ID          # env-var names YOUR chart expects
      clientSecret: OAUTH_CLIENT_SECRET
      issuer: OPENID_PROVIDER_URL        # the OIDC discovery URL (.../.well-known/openid-configuration), not the bare issuer
  casdoorPolicy: retain          # retain (default) or delete the Casdoor app when the CR is removed
```

Register it in the overlay's `kustomization.yaml` `resources:` list.

Notes:
- **`clientId` is the identity.** The controller uses it as both the Casdoor
  application `name` (its DB primary key, looked up as `admin/<name>`) and the
  OIDC `client_id`. Pick it once and don't rename it.
- **No committed secret.** Leave the Casdoor `clientSecret` generation to the
  controller — do not seed one in `init_data.json` or hardcode one in the chart.
- **`issuer` is the discovery URL.** The controller writes the full
  `https://id.<BASE_DOMAIN>/.well-known/openid-configuration` endpoint into the
  Secret's `issuer` key — exactly what clients like open-webui's
  `OPENID_PROVIDER_URL` expect, not the bare issuer.
- **`scopes` is a no-op (accepted for ergonomics).** The CR accepts a `scopes`
  list, but the controller never writes it to Casdoor (OIDC scopes are driven by
  the client's auth request). Setting it surfaces a `ScopesIgnored=True` status
  condition; reconcile still reaches `Ready`.
- **`redirectUris` drives drift reconciliation.** Editing this list (or
  `grantTypes` / `tokenFormat` / `expireInHours`) on the CR will make
  the controller `update-application` on the next reconcile to match.

## Token format: prefer `JWT-Standard`

`tokenFormat` controls what Casdoor puts inside the ID/access tokens. Casdoor
offers four values; **default to `JWT-Standard`** for native-OIDC apps:

| Format | Claims emitted | Use |
|--------|----------------|-----|
| `JWT` | The **entire Casdoor user object** (every field, incl. empty) | Avoid for OIDC clients |
| `JWT-Empty` | Only non-empty user fields | Too sparse (omits `email` unless set) |
| `JWT-Custom` | Only the fields listed in `tokenFields` | Explicit-whitelist fallback |
| `JWT-Standard` | Spec-compliant OIDC claims only | **Recommended** |

### The trap: plain `JWT` + a strict OIDC client (hit on vaultwarden)

Plain `JWT` embeds the whole user object. One of those fields is `address`,
which in Casdoor's data model is a `[]string` — so it is serialized as
`"address": []`. **Strict** OIDC client libraries deserialize the OIDC
`address` claim as a structured object and abort the *entire token parse* on
`[]`. Rust's `openidconnect` crate (used by **vaultwarden**) does exactly this:

```
[vaultwarden::sso_client][ERROR] Failed to contact token endpoint: Parse(
  "address: invalid length 0, expected struct AddressClaim with 6 elements",
  [123, 10, 32, 32, 34, 97, 99, 99, 101, 115, 115, ...])
```

Symptom: after the IdP redirect, the app shows a screen full of numbers (the
raw token byte array dumped in the error) and SSO login fails — even though
the redirect, login, and TLS are all fine. **Lenient** libraries (Python
`authlib`, used by open-webui / seafile / litellm) tolerate Casdoor's shapes,
so they worked with plain `JWT`; only the strict Rust client choked.

`JWT-Standard` emits standard OIDC claims and includes `address` **only when
the `address` scope is requested** — so for the usual `openid email profile`
the claim is omitted and the parse error disappears. It also stops leaking
`password` / `passwordSalt`, which plain `JWT` puts in the token.

If `JWT-Standard` is unsuitable for some app, the fallback is `JWT-Custom`
with an explicit field whitelist via `applicationOverrides` (a non-managed
Casdoor field), which also excludes `address`:

```yaml
spec:
  tokenFormat: JWT-Custom
  applicationOverrides:
    tokenFields: [Email, Name, DisplayName]   # Casdoor User struct field names; no Address
```

> `tokenFormat` is a **controller-managed** (typed SSOClient spec) field — set
> it directly on the CR. `tokenFields`, by contrast, is *not* managed and goes
> through `applicationOverrides`. Picking the right door for each field is easy
> to get backwards.

## 2. Wire the chart to the Secret

Point the chart's OIDC environment variables at the Secret the controller
writes, using `valueFrom.secretKeyRef`. From an open-webui HelmRelease:

```yaml
extraEnvVars:
  - name: OAUTH_CLIENT_ID
    valueFrom:
      secretKeyRef:
        name: open-webui-sso
        key: OAUTH_CLIENT_ID
  - name: OAUTH_CLIENT_SECRET
    valueFrom:
      secretKeyRef:
        name: open-webui-sso
        key: OAUTH_CLIENT_SECRET
  - name: OPENID_PROVIDER_URL
    valueFrom:
      secretKeyRef:
        name: open-webui-sso
        key: OPENID_PROVIDER_URL
```

The Secret name is `spec.output.secretName` and the keys are the
`spec.output.keys` you declared. Keep your chart's own `OPENID_REDIRECT_URI`
(wherever it lives) pointing at the same callback URL as `spec.redirectUris` —
OIDC requires them to match.

## 3. Order your app after `casdoor-sso`

Add a Flux dependency so your app's Kustomization reconciles after the CRD and
controller exist (otherwise the CR is briefly rejected until Flux retries):

```yaml
dependsOn:
  - name: casdoor-sso
```

## 4. Trust the private CA (mount the LibrePod root CA)

The app makes **server-side** HTTPS calls to `https://id.<BASE_DOMAIN>` — OIDC
discovery, the token exchange, and the userinfo endpoint. That certificate is
issued by the cluster's internal `StepClusterIssuer`, **not** a public CA, so
the app's TLS stack rejects it:

- Go: `x509: certificate signed by unknown authority`
- Node: `unable to get local issuer certificate`
- Python `requests`: `SSLCertVerificationError`

Every SSO app therefore merges the LibrePod root CA into its trust bundle. The
wiring lives in the overlay and has two parts: **(1)** replicate the CA into the
app namespace, and **(2)** fuse it into the pod's trust bundle and point the app
at it.

### (1) Replicate the CA into the namespace (Reflector stub)

The CA lives in `ConfigMap/step-certificates-certs` in namespace `step-ca` and
is **not** auto-distributed. Each app pulls a copy via a Reflector `reflects`
stub in its overlay `kustomization.yaml` — identical for every app:

```yaml
configMapGenerator:
  - name: step-certificates-certs
    options:
      disableNameSuffixHash: true              # REQUIRED — see below
      annotations:
        reflector.v1.k8s.emberstack.com/reflects: "step-ca/step-certificates-certs"
```

> `disableNameSuffixHash: true` is **required**, not cosmetic. The volume mounts
> `configMap/step-certificates-certs` by this exact name, and Reflector keys its
> replication off the `reflects` annotation on this exact object. A kustomize
> hash suffix survives mechanically (kustomize rewrites the volume ref), but any
> future edit to the generator re-hashes the object → prune + recreate an empty
> stub → a window where the pod can't mount the CA → OIDC startup failure.

### (2) Fuse + mount the CA, and point the app at it

An `alpine` init container concatenates the system CA bundle with the LibrePod
root CA (and, for some apps, the intermediate) into an `emptyDir`, which the
main container mounts over `/etc/ssl/certs/ca-certificates.crt`. How you express
that depends on the workload:

**Raw `Deployment`** (headscale, vaultwarden, seafile, litellm) — a strategic-
merge patch in the overlay, `overlays/librepod/deployment-ca-patch.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <app>
spec:
  template:
    spec:
      initContainers:
        - name: merge-ca-bundle
          image: alpine:3.19
          command: ["/bin/sh", "-c"]
          args:
            - |
              set -e
              cat /etc/ssl/certs/ca-certificates.crt > /mnt/merged-ca/ca-certificates.crt
              echo "" >> /mnt/merged-ca/ca-certificates.crt
              echo "# LibrePod Root CA" >> /mnt/merged-ca/ca-certificates.crt
              cat /mnt/root-ca/root_ca.crt >> /mnt/merged-ca/ca-certificates.crt
              # If the app also needs the intermediate (litellm, immich), append it:
              # echo "" >> /mnt/merged-ca/ca-certificates.crt
              # echo "# LibrePod Intermediate CA" >> /mnt/merged-ca/ca-certificates.crt
              # cat /mnt/root-ca/intermediate_ca.crt >> /mnt/merged-ca/ca-certificates.crt
          volumeMounts:
            - { name: root-ca-cert, mountPath: /mnt/root-ca, readOnly: true }
            - { name: merged-ca-bundle, mountPath: /mnt/merged-ca }
      containers:
        - name: <app>
          volumeMounts:
            - name: merged-ca-bundle
              mountPath: /etc/ssl/certs/ca-certificates.crt
              subPath: ca-certificates.crt
              readOnly: true
      volumes:
        - name: root-ca-cert
          configMap:
            name: step-certificates-certs
            items:
              - { key: root_ca.crt, path: root_ca.crt }
              # - { key: intermediate_ca.crt, path: intermediate_ca.crt }   # if appended above
        - name: merged-ca-bundle
          emptyDir: {}
```

Register it under `patches:` in the overlay `kustomization.yaml`. The trust *env
vars* (next subsection) go wherever the app's other env vars live — in the
Deployment `env:` (headscale, vaultwarden) or the `envFrom` ConfigMap (seafile's
`base/seafile.env`, litellm's `base/litellm.env`) — **not** necessarily in this
patch.

**`HelmRelease`** (immich, open-webui, oauth2-proxy) — there is **no generic
snippet**: each chart names its init-container/volume hooks differently, so copy
the values block from the closest existing app:

| App | Chart schema family | Copy from |
|-----|---------------------|-----------|
| immich | bjw-s common v5 (`controllers.main`, `persistence.advancedMounts`) | `apps/immich/overlays/librepod/patch-helmrelease.yaml` |
| open-webui | open-webui chart (`volumes`, `volumeMounts.initContainer`/`.container`, `extraInitContainers`) | `apps/open-webui/overlays/librepod/helmrelease.yaml` |
| oauth2-proxy | oauth2-proxy chart (`extraVolumes`, `extraVolumeMounts`, `extraInitContainers`) | `apps/oauth2-proxy/overlays/librepod/helmrelease.yaml` |

The init-container *script* and the two volume names (`root-ca-cert`,
`merged-ca-bundle`) are identical across all of them — only the surrounding
Helm-values shape differs.

### Which trust env var(s)?

The merged bundle is mounted at the system bundle path, but most runtimes do
**not** read that path by default — they need an env var pointed at it:

| Env var(s) to set | When | Apps |
|-------------------|------|------|
| `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` | Go, or Python using `ssl`/`httpx` | headscale, vaultwarden, oauth2-proxy, open-webui |
| `SSL_CERT_FILE` **and** `REQUESTS_CA_BUNDLE` | Python using `requests` (honors `REQUESTS_CA_BUNDLE`, not `SSL_CERT_FILE`) | seafile, litellm |
| `SSL_CERT_FILE` **and** `NODE_EXTRA_CA_CERTS` | Node.js (`tls`/`fetch` ignores `SSL_CERT_FILE`) | immich |

> Rule of thumb: always set `SSL_CERT_FILE`; add `REQUESTS_CA_BUNDLE` for a
> Python `requests`-based app and `NODE_EXTRA_CA_CERTS` for a Node app. A
> missing env var surfaces as a *runtime* TLS error after the pod boots
> (discovery/token exchange fails) — distinct from the boot-time `x509` crash
> you get when no CA is mounted at all.

### Gotcha: strategic-merge reorders list items (raw-`Deployment` carrier)

A kustomize strategic-merge patch emits **patch-new list items before the
Deployment's existing sibling items**. If your base `Deployment` already has its
own init containers or volumes (e.g. seafile's `set-ownership` init container, or
`config`/`data` volumes), the CA items jump to the front of `initContainers` /
`volumeMounts` / `volumes`. This is **functionally safe** — Kubernetes treats
`volumeMounts`/`volumes` order as irrelevant, and the existing init containers
are independent of the CA merge — but it is **not byte-identical**: the
pod-template hash changes, so the pod restarts once on the next reconcile.

It only bites apps whose base has sibling items: headscale/vaultwarden have none
(byte-identical); seafile/litellm do (one-time restart). If a zero-restart
refactor matters, use a JSON6902 *append* patch (`op: add ... /-`) instead — at
the cost of a second patch mechanism.

## Verifying it worked

```bash
kubectl get ssoclient <name> -n <ns>          # Phase=Ready, status.clientId populated
kubectl -n <ns> get secret <app>-sso -o jsonpath='{.data}'   # three keys present
```

The controller's status conditions carry `Ready=True` (`Provisioned`) once the
Casdoor app is synced and the Secret is up to date. If Casdoor is unreachable or
the admin token is missing, the CR goes `Phase=Failed` and the controller backs
off and retries every 30s until it self-heals.

## Rotating a secret

```bash
kubectl annotate ssoclient <name> -n <ns> \
  marketplace.librepod.org/rotate-secret=true --overwrite
```

On the next reconcile the controller generates a new `clientSecret`, pushes it to
Casdoor, and rewrites the Secret. The annotation is cleared automatically so it
fires once. Restart the consuming app (or let it re-read the Secret) to pick up
the new value.

Sign-up is disabled by platform policy (`enableSignUp: false`); manage users via
the (forthcoming) user-management app rather than open registration.

---

## Controller credentials: Casdoor M2M Access Key

The controller authenticates to Casdoor's admin API with a **machine-to-machine
(M2M) Access Key** — an `accessKey`/`accessSecret` pair (managed under the
Casdoor **Keys** page) sent as query params on every request. There is no admin
password, personal access token, or bootstrap Job: the key *is* the auth.

**The key must be `User`-typed and scoped to the `admin` user.** Casdoor
application management (add/update/delete) is **admin-only** — an
`Organization`-scoped key can *read* applications but its add/update/delete
calls return `Unauthorized operation`. A `User = admin` key runs with full admin
permissions and covers the controller's CRUD.

The controller reads the key from `Secret/casdoor-api-credentials` in namespace
`casdoor-sso` (keys `accessKey`, `accessSecret`), injected via `secretKeyRef` on
the controller Deployment. Empty values yield `Unauthorized operation`, which the
reconciler backs off and retries until the Secret is populated.

### Provisioning the Access Key (per deployment)

1. In Casdoor, create a key on the **Keys** page: name it
   `librepod-sso-controller`, **Type = User**, **User = `admin`**. Copy the
   generated `accessSecret` immediately (it is not shown again).
2. Provide `Secret/casdoor-api-credentials` carrying that `accessKey`/
   `accessSecret` (per-deployment; not committed):
   ```bash
   kubectl -n casdoor-sso create secret generic casdoor-api-credentials \
     --from-literal=accessKey='<accessKey>' \
     --from-literal=accessSecret='<accessSecret>'
   ```

> The key is **not** seeded via `init_data.json`: Casdoor's `-export` does not
> dump the `keys` table, and provisioning the key out-of-band avoids committing
> the `accessSecret`. For the dev pilot the key + Secret are created manually;
> production automation (e.g. a one-shot Job that mints the key via the admin
> API) is the remaining open item. See the pilot runbook.
