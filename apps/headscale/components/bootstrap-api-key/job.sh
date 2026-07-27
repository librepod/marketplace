#!/bin/sh
# Bootstraps Secret/headscale-api-key on first install so headplane can start
# with OIDC enabled (headplane's config validator hard-fails without this key).
#
# Flow: wait for headscale -> skip if the Secret already exists (idempotent) ->
# mint a long-lived key by exec'ing `headscale apikeys create` in the headscale
# container -> write the Secret. headplane's volume is REQUIRED (optional: false
# in components/headplane/deployment.yaml), so its pod waits in ContainerCreating
# until this Secret exists and then auto-starts — no CrashLoopBackOff, and no
# need for this Job to restart headplane.
#
# IMAGE DEPENDENCY: minting execs `headscale apikeys create` in the headscale
# container, which requires the headscale CLI to be callable via exec. This is
# true for the pinned v0.28.0-debug image. If you switch to the distroless
# non-debug image, exec the binary by its full path instead, or move minting to
# a unix-socket sidecar in the headscale pod (headscale's default unix_socket
# allows unauthenticated CLI access from within the pod). See headscale config:
# unix_socket: /var/run/headscale/headscale.sock
set -eu

NS="${HEADSCALE_NAMESPACE:-headscale}"
EXP="${API_KEY_EXPIRATION:-999d}"

echo "Waiting for headscale Deployment to be Available..."
kubectl wait deploy/headscale -n "$NS" --for=condition=Available --timeout=300s

# Idempotency: a re-run (e.g. after this Job was deleted and recreated by Flux)
# must NOT mint a second key. If the Secret exists, assume the key is valid.
if kubectl get secret headscale-api-key -n "$NS" >/dev/null 2>&1; then
  echo "Secret/headscale-api-key already exists; nothing to do."
  exit 0
fi

echo "Minting a ${EXP} Headscale API key..."
API_KEY="$(kubectl exec deploy/headscale -n "$NS" -c headscale -- headscale apikeys create --expiration "$EXP")"
if [ -z "$API_KEY" ]; then
  echo "ERROR: headscale apikeys create returned an empty key" >&2
  exit 1
fi

echo "Creating Secret/headscale-api-key..."
# Idempotent create (dry-run | apply) in case of a race with a concurrent run.
kubectl create secret generic headscale-api-key -n "$NS" \
  --from-literal=api_key="$API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Done. headplane will mount this Secret and continue starting."
