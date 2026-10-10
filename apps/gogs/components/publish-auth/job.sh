#!/bin/sh
# Publishes the committed user-apps source credential (the gogs flux account,
# apps/gogs/components/bootstrap-admin/secret.env) into the openbao KV store at
# apps/user-apps-source — the single entry every consumer namespace syncs from
# via ExternalSecret (flux-system's GitRepository auth, marketplace-ui's
# user-apps-git-auth). Producer-push: openbao never reads from this namespace;
# it only admits this Job's ServiceAccount through the "gogs" kubernetes-auth
# role (provisioned by the openbao bootstrap Job, policy gogs-write-apps —
# write-only on that one KV path).
#
# Deliberately non-fatal on every failure path: gogs gates the whole user-apps
# chain and must never block on openbao. If publication cannot proceed, warn
# and exit 0 — the TTL + Flux-recreate cycle (gogs Kustomization interval 10m)
# re-runs this Job and retries. Nothing alarms on a PERSISTENT failure — the
# signal is consumer-side: the ExternalSecrets never sync (GitRepository auth
# failures, installer "no username/password" errors). When that shows up, grep
# this Job's log for "skipping".
#
# Env (envFrom Secret/user-apps-source-auth): username, password.
# Shell vars are braceless on purpose: Flux postBuild.substitute rewrites
# ${VAR} patterns in ConfigMap content (docs/FLUX_WORKFLOW.md).
SA=/var/run/secrets/kubernetes.io/serviceaccount

if [ -z "$username" ] || [ -z "$password" ]; then
  echo "WARNING: username/password unset (Secret/user-apps-source-auth missing keys); skipping publication." >&2
  exit 0
fi

# ~3 min worst case, sized to stay under the gogs Kustomization's 5m
# health-check timeout (wait: true). A cold boot routinely starts this Job
# before openbao exists: login failing covers both "server not up" and
# "role gogs not provisioned yet" (this Job races the openbao bootstrap), so
# login+put are one attempt — no separate health poll.
i=0
while [ "$i" -lt 10 ]; do
  i=$((i + 1))
  TOKEN="$(bao write -field=token auth/kubernetes/login \
    role=gogs jwt="$(cat "$SA/token")" 2>/dev/null)" || TOKEN=""
  if [ -n "$TOKEN" ]; then
    if BAO_TOKEN="$TOKEN" bao kv put apps/user-apps-source \
      username="$username" password="$password" >/dev/null 2>&1; then
      echo "user-apps source credential published to openbao KV at apps/user-apps-source."
      exit 0
    fi
    echo "WARNING: openbao login ok but KV put apps/user-apps-source failed (attempt $i/10); retrying." >&2
  else
    echo "openbao not admitting role gogs yet (attempt $i/10); retrying in 15s..."
  fi
  sleep 15
done
echo "WARNING: openbao publication did not succeed in 10 attempts (~3 min); skipping — the next Job re-run retries." >&2
exit 0
