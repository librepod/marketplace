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
  tokenFormat: JWT
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
  `https://sso.<BASE_DOMAIN>/.well-known/openid-configuration` endpoint into the
  Secret's `issuer` key — exactly what clients like open-webui's
  `OPENID_PROVIDER_URL` expect, not the bare issuer.
- **`scopes` is a no-op (accepted for ergonomics).** The CR accepts a `scopes`
  list, but the controller never writes it to Casdoor (OIDC scopes are driven by
  the client's auth request). Setting it surfaces a `ScopesIgnored=True` status
  condition; reconcile still reaches `Ready`.
- **`redirectUris` drives drift reconciliation.** Editing this list (or
  `grantTypes` / `tokenFormat` / `expireInHours`) on the CR will make
  the controller `update-application` on the next reconcile to match.

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
