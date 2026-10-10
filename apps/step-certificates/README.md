# Step Certificates Application

Step CA — the LibrePod cluster Certificate Authority. Issues X.509
certificates for cert-manager (via step-issuer) and provides the root CA
that every HTTPS app in the cluster trusts.

## Architecture

Deployed as the Smallstep `step-certificates` Helm chart with all
chart-managed initialization disabled. A custom initContainer runs
`step ca init --no-db` on first boot and writes the whole `$STEPPATH` tree
to a PVC mounted at `/home/step`; the chart's default ConfigMap/Secret
volume mounts are stripped via postRenderers.

```
step-certificates Deployment (HelmRelease)
├─ initContainer step-ca-init   ── `step ca init --no-db` on the PVC
│                                  (idempotent: skips if config/ca.json
│                                  exists; generates both passwords)
├─ container step-certificates  ── CA API on :9000
└─ sidecar root-ca-server       ── nginx serving root_ca.crt over HTTP
                                   (root-ca.${BASE_DOMAIN}) for humans

bootstrap Job (TTL-GC'd; Flux recreates it every ~10m reconcile)
├─ initContainer wait-for-ca    ── polls the CA /health endpoint
└─ container bootstrap          ── see "Secret flow" below
```

## Secret flow

The CA material lives on the PVC (`step-certificates-data`, NFS). The
bootstrap Job is the only producer, and it fans the CA out to exactly two
openbao paths plus one local Secret:

1. **openbao KV `apps/step-ca`** (producer push, best-effort with retry on
   the next Job re-run): the public `root_ca.crt` + `intermediate_ca.crt`
   that consumer namespaces sync via ExternalSecret
   (docs/sso-app-author-guide.md §4).

2. **openbao KV `system/step-ca`** — the full CA backup: certs, **private
   keys**, `ca.json`/`defaults.json`, both passwords. Separate engine from
   `apps/` on purpose: `eso-read-apps` reads all of `apps/*`, so regular
   apps cannot reach the private keys. This is the disaster-recovery copy —
   the PVC is otherwise the only place the private keys exist.

3. **Secret `step-certificates-provisioner-password`** (step-ca namespace):
   `password` + `kid` + `ca_bundle` — the complete input set for
   step-issuer's `StepClusterIssuer`. This deliberately stays a plain local
   Secret: step-issuer readiness gates cert-manager → the wildcard cert →
   openbao's ingress, so sourcing it from openbao (ESO) could deadlock a
   cold boot.

All API calls in the Job are plain `curl` against the Kubernetes and
openbao APIs using the Job's ServiceAccount token — the step-ca image has
no kubectl, and downloading one at runtime is ~60MB through flaky egress.

## CA restore (automatic)

The initContainer runs **before** any fresh `step ca init`: if the PVC has
no CA and openbao holds a backup at `system/step-ca`, the CA is restored
from it (all files staged and verified complete before moving into place).
A wiped PVC therefore does **not** rotate the device's root CA — the
fingerprint survives, and every browser/phone that trusts it keeps working.
The Deployment's ServiceAccount (`step-ca-restore`) is bound in openbao to
a read-only role on exactly that path.

Fresh-init fallbacks (each logged loudly):

| Condition | Behaviour |
|---|---|
| openbao Service DNS unresolvable | virgin boot, no backup possible — fresh init immediately |
| backup path returns 404 | no backup was ever written — fresh init immediately |
| backup incomplete | the Job writes KV versions atomically, so this is garbage — fresh init |
| openbao deployed but unusable for 5 min | mid-bootstrap race — fresh init after deadline (rotation beats wedged CA) |

To force a genuinely new CA (e.g. decommissioning): wipe the PVC **and**
delete the `system/step-ca` backup from openbao, then restart the
Deployment.

## Re-provisioning / CA rotation

A wiped PVC alone no longer rotates the CA (see "CA restore" above).
After a deliberate CA re-init (fresh PVC + backup deleted), delete the old
outputs so the producers re-run:

```bash
kubectl -n step-ca delete secret step-certificates-provisioner-password
kubectl -n step-ca delete stepclusterissuer step-cluster-issuer   # CRD from step-issuer
# then: Flux re-creates the Job (or delete it to force an immediate run),
# and restart the step-issuer Deployment to re-run its bootstrap
```

The openbao side needs no cleanup — the next Job run overwrites both
`apps/step-ca` and `system/step-ca` wholesale.

## Components

- `init-container` — CA init script + env (ConfigMaps consumed by the
  HelmRelease's `extraInitContainers`)
- `bootstrap-step-resources` — the bootstrap Job: RBAC (ServiceAccount +
  Role: get/create/patch Secrets) and the script described above
- `root-ca-server` — nginx sidecar + Service + IngressRoute serving the
  root CA over plain HTTP for out-of-cluster humans (browsers, phones)

## Dependencies

- `storage` (the PVC), and openbao arrives later on cold boot — CA
  publication retries until it is reachable
- cert-manager + step-issuer consume the outputs (step-issuer depends on
  this app's Kustomization)

## References

- [Smallstep step-ca Documentation](https://smallstep.com/docs/step-ca/)
- [StepIssuer for cert-manager](https://github.com/smallstep/step-issuer)
