# bootstrap-cluster-issuer

A Kustomize component for `step-issuer` that creates the `StepClusterIssuer`
resource automatically. It eliminates the need to manually extract CA
credentials or store sensitive data in Git.

## Why this exists

The `StepClusterIssuer` requires three pieces of data that only exist at
runtime, after the Step CA has been initialized:

- The root CA certificate (base64-encoded) for the `caBundle` field
- The JWK provisioner's `kid`
- A reference to the provisioner password Secret

All three arrive in one place: the `step-certificates-provisioner-password`
Secret in namespace `step-ca`, created by the step-certificates bootstrap
Job (`password` + `kid` + `ca_bundle` keys).

## How it works

A bootstrap **initContainer** is injected into the step-issuer Deployment
via the HelmRelease `postRenderers` (the chart's own ServiceAccount, granted
RBAC by this component's Role/ClusterRole). On every pod (re)start it:

1. Checks whether `StepClusterIssuer/step-cluster-issuer` already exists
   (raw API GET) — exits 0 if so
2. Polls until the `step-certificates-provisioner-password` Secret is
   available (30 × 2s)
3. Builds the `StepClusterIssuer` JSON with `jq` and POSTs it (raw API)

```
Secret/step-certificates-provisioner-password (from step-certificates)
    ↓ password · kid · ca_bundle
initContainer (step-ca image: curl + jq, no kubectl, no PVC mount)
    ↓ POST (cluster-scoped resource — API path has no namespace segment)
StepClusterIssuer/step-cluster-issuer
```

No kubectl download, no step-certificates PVC mount, and deliberately no
openbao dependency: step-issuer readiness gates cert-manager → the wildcard
cert → openbao's ingress, so sourcing the Secret from openbao (ESO) could
deadlock a cold boot.

## File structure

```
components/bootstrap-cluster-issuer/
├── kustomization.yaml   # Component; generates ConfigMaps from job.env and job.sh
├── job.sh               # Bootstrap script (mounted as ConfigMap)
├── job.env              # Environment variables (mounted as ConfigMap)
├── role.yaml            # ClusterRole (StepClusterIssuer) + Role (Secret get)
└── rolebinding.yaml     # ClusterRoleBinding + RoleBinding → chart SA "step-issuer"
```

## Configuration

| Variable | Value | Description |
|---|---|---|
| `STEPISSUER_NAMESPACE` | `step-ca` | Namespace of the Secret and the StepClusterIssuer |
| `STEP_ISSUER_URL` | `https://step-certificates.step-ca.svc.cluster.local` | CA URL for the issuer spec |
| `PROVISIONER_NAME` | `default-jwk` | Name of the JWK provisioner to use |

## RBAC

Bound to the chart's `step-issuer` ServiceAccount:

- **ClusterRole + ClusterRoleBinding** — `get`/`create` on
  `stepclusterissuers.certmanager.step.sm`
- **Role + RoleBinding** (namespace `step-ca`) — `get` on `secrets`

## Error handling

| Failure | Behaviour |
|---|---|
| Provisioner password Secret not available after 60s | Exit 1 → pod never becomes ready, restarts and retries |
| `kid`/`ca_bundle` missing from the Secret | Exit 1 (stale Secret from an older bootstrap — delete it and reconcile) |
| POST fails | Non-zero exit; next pod restart retries |

## Re-provisioning

The kid/caBundle are fixed at CA init. After a CA re-init, delete the
StepClusterIssuer **and** the provisioner-password Secret, then restart the
step-issuer Deployment (see the step-certificates README for the full
runbook).
