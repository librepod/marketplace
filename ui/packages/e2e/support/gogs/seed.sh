#!/bin/sh
# Seeds a bare Gogs for the Tier 1 e2e: creates the flux admin (gogs admin
# create-user, like the prod postStart hook), the user-apps repo, and an empty
# root kustomization.yaml. Run as a one-shot after `gogs web` is up. Lives in a
# file (not inline in the compose YAML) so docker-compose does NOT interpolate
# the shell's $VAR references. Called by docker-compose.e2e.yml's gogs-seed.
#
# gogs-ready.mjs is the final gate that this actually completed (it polls until
# the seeded state is observable).
set -e

USERNAME="flux"
PASSWORD='pass@w0rd'
BASIC="$(printf '%s:%s' "$USERNAME" "$PASSWORD" | base64 | tr -d '\n')"
GOGS="http://gogs:3000"

# Wait until the gogs web server answers — the DB schema `gogs admin create-user`
# needs is only initialized when `web` starts (a create-user before web starts
# fails on a fresh DB and leaves NO user). Mirrors the prod postStart hook.
echo "gogs-seed: waiting for gogs web..."
i=0
until curl -sf "$GOGS/" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "gogs-seed: gogs web not reachable after 120s" >&2
    exit 1
  fi
  sleep 2
done

# 1) Create the flux admin (CLI). On a fresh volume this succeeds; the probe
#    covers an idempotent re-run where the user already exists.
echo "gogs-seed: ensuring admin user '$USERNAME'..."
cd /app/gogs
if ! gosu git ./gogs admin create-user \
      --name "$USERNAME" --password "$PASSWORD" \
      --email "flux@libre.pod" --admin \
      --config /data/gogs/conf/app.ini >/dev/null 2>&1; then
  if ! curl -sf -o /dev/null "$GOGS/api/v1/users/$USERNAME/tokens" \
       -X POST -H "Authorization: Basic $BASIC" -H "Content-Type: application/json" \
       -d '{"name":"seed-probe"}'; then
    echo "gogs-seed: create-user failed and $USERNAME does not authenticate" >&2
    exit 1
  fi
fi

# 2) Create the user-apps repo (admin API). Swallow "already exists".
echo "gogs-seed: ensuring repo '$USERNAME/user-apps'..."
curl -sf -o /dev/null "$GOGS/api/v1/admin/users/$USERNAME/repos" \
  -X POST -H "Authorization: Basic $BASIC" -H "Content-Type: application/json" \
  -d '{"name":"user-apps","description":"LibrePod user apps","private":true}' || true

# 3) Seed the root kustomization.yaml in the clean empty state (resources: []).
#    Gogs 0.14.2's contents API can't PUT to a repo with no commits/branch, so
#    push the initial commit via git (the image ships git). URL-encode the
#    password (@ -> %40) for the embedded basic creds. gogs-ready.mjs verifies
#    the result; on an idempotent re-run the clone carries the existing file and
#    `git push` is a no-op (already up to date).
echo "gogs-seed: seeding root kustomization.yaml..."
cd /tmp
rm -rf user-apps
PWD_ENC="$(printf '%s' "$PASSWORD" | sed 's/@/%40/g')"
export GIT_TERMINAL_PROMPT=0
if ! git clone --quiet "http://$USERNAME:$PWD_ENC@gogs:3000/$USERNAME/user-apps.git" 2>/dev/null; then
  echo "gogs-seed: git clone of user-apps failed" >&2
  exit 1
fi
cd user-apps
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: []\n' > kustomization.yaml
git add kustomization.yaml
git -c user.email="flux@libre.pod" -c user.name="flux" commit -q -m "seed root kustomization" 2>/dev/null \
  || echo "gogs-seed: nothing to commit (kustomization already present)"
git push --quiet origin HEAD:master 2>&1 | grep -viE "remote:|^To http|->|.up.to.date" || true
cd /
rm -rf /tmp/user-apps

echo "gogs-seed: done."
