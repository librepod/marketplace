# OpenBao

Open-source (MPL-2.0) secrets management, API-compatible with HashiCorp Vault.
Installed via the official Helm chart in **standalone mode** (single replica,
`pebbledb` storage on a 10Gi PVC) with the agent **injector** enabled.

## Auto-unseal (static seal)

The server config uses OpenBao's builtin `seal "static"`: the master key is
wrapped by a 32-byte AES-256-GCM key stored as `/openbao/seal/unseal.key` on
the dedicated `openbao-seal` PVC (128Mi). The key is generated once by the
`seal-key-init` init container and never leaves that volume — so OpenBao comes
back **unsealed automatically** after pod restarts and node reboots.

> **Trust caveat**: the seal key sits on the NFS volume; anyone with
> cluster-admin or NFS access can read it and unseal the data. The bootstrap
> Job additionally mirrors the credentials (root token + recovery keys) to
> `credentials.json` on the same volume so reinstalls can restore them — NFS
> access therefore yields the root token directly. On a single-tenant
> LibrePod cluster this is the same trust domain as every other PVC-backed
> secret. Back up the seal key file together with the data volume — losing
> both the key and the recovery keys means the data is unrecoverable.

Key rotation is supported by the seal itself: generate a new key, then set
`current_key` to the new file and `previous_key` to the old one (with
matching `*_key_id` labels) and restart the server.

## First boot

The `openbao-credentials` Job runs after deployment and does everything
idempotently:

1. `bao operator init` (once) — the **root token** and **recovery keys** are
   stored in the `openbao-credentials` Secret in this namespace **and
   mirrored to `credentials.json` on the seal PVC**, which is what makes
   reinstalls self-healing (see below). Extract them and store them somewhere
   safe; optionally delete the Secret:
   ```sh
   kubectl get secret openbao-credentials -n openbao \
     -o jsonpath='{.data.recovery-keys}' | base64 -d
   ```
2. enables the **KV v2 engine at `apps/`**
3. enables the **Kubernetes auth method** (no static reviewer JWT — the
   server ServiceAccount holds `system:auth-delegator` via the chart)
4. writes the policies and roles. Policies are site-specific: every `*.hcl`
   in the overlay's `policies/` dir is mounted into the Job and written as
   an OpenBao policy named after its file:
   - `eso-read-apps` ← role `external-secrets` (SA `openbao-eso`, ns `openbao`):
     **read** `apps/*`
   - `marketplace-ui-write-apps` ← role `marketplace-ui`
     (SA `marketplace-ui`, ns `marketplace-ui`): **create/update** `apps/*`
5. enables the **file audit device** at `/openbao/audit/audit.log`

## Audit logs (10Gi, 30 day retention)

The file audit device has no built-in rotation; the
`openbao-audit-rotation` CronJob runs daily at 03:17 UTC, renames the active
log, sends the server a SIGHUP (documented re-open mechanism) and deletes
rotated files older than 30 days.

## External Secrets integration

A `ClusterSecretStore` named `openbao` is provisioned cluster-wide from
`infrastructure/system-configs` (openbao itself is a system app,
`infrastructure/system-apps/openbao.yaml`), authenticating via the
Kubernetes auth method:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: demo
  namespace: anywhere
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: openbao
  target:
    name: demo-secret
  data:
    - secretKey: password
      remoteRef:
        key: apps/demo   # KV v2: engine-relative path
        property: password
```

## TLS

A dedicated certificate for `openbao.<BASE_DOMAIN>` is issued by
cert-manager via the cluster's `StepClusterIssuer` (secret `openbao-tls`).
The IngressRoute is TLS-only on `websecure` — there is intentionally no
plain-HTTP route.

## Version bumps

Update together: `metadata.yaml` `spec.version`, the overlay
`patch-helmrelease.yaml` `server.image.tag` and
`injector.agentImage.tag`, the overlay `images[].newTag` (bootstrap Job),
and review the pinned chart `version: "~0.30.0"`.

## Operational notes

- **Sealed pod?** With the static seal this should not happen; if the seal
  key file was lost, use the recovery keys with
  `bao operator generate-root` for root access, but the storage master key
  cannot be recovered without the seal key.
- **Reinstall (self-healing)**: NFS rebinds same-named PVCs, so the seal key,
  the data **and the mirrored credentials** all survive reinstalls. On
  reinstall the bootstrap Job restores the `openbao-credentials` Secret from
  the seal-volume copy and re-applies the configuration idempotently — the
  server auto-unseals and admin access is preserved, no manual steps. If the
  data PVC alone is wiped, the Job detects the stale credentials, removes the
  seal-volume copy and instructs a fresh init; wiping only the seal PVC
  bricks the data (the master key cannot be unwrapped).
- **HA**: intentionally single-replica — Raft/integrated storage on NFS is a
  corruption risk and there is no quorum on single-device clusters.
