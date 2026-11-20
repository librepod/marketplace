#!/bin/sh
# Hermes sentinel launcher. First boot installs hermes-agent INTO the PVC
# (the install mode `hermes update` can move in place); every later boot is
# a fast path — checkout, tools, sessions and memory are already on /opt/data.
# Braceless $VAR on purpose: Flux substitution rewrites ${VAR} patterns in
# manifest content (rule in the librepod-app skill); braceless forms resolve
# from envFrom at runtime.
set -eu

# HOME/HERMES_HOME arrive via envFrom (configmap hermes-agent).
HERMES_BIN=/opt/data/.local/bin/hermes
export PATH="/opt/data/.local/bin:$PATH"
WORKSPACE=/opt/data/workspace

if [ ! -x "$HERMES_BIN" ]; then
  echo "[sentinel] first boot: installing hermes-agent into the PVC (takes several minutes)"
  # git/ca-certificates/curl ship in the pinned toolkit image (its Dockerfile
  # bakes them so the runtime never needs apt-get). Upstream's installer,
  # fetched from the repo mirror: the website (hermes-agent.nousresearch.com)
  # answers 403 to some egress networks, and scripts/install.sh in the repo is
  # the same file the site serves. @main installs the latest STABLE release
  # (the channel `hermes update` then tracks); the overlay's image tag pins
  # only the dependency toolkit and moves independently of the checkout.
  # NOTE: this is a bash script — never run it with sh.
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o /tmp/hermes-install.sh
  bash /tmp/hermes-install.sh --non-interactive --dir /opt/data/hermes-agent
  echo "[sentinel] install complete"
fi

# Model/provider selection is left entirely to hermes: the installed
# config.yaml defaults to provider "auto" (credential auto-detection), API
# keys arrive via envFrom, and the user switches models in-band with /model.

# Workspace context the agent reads every conversation: where its world ends.
mkdir -p "$WORKSPACE"
if [ ! -f "$WORKSPACE/AGENTS.md" ]; then
  cat > "$WORKSPACE/AGENTS.md" <<'EOF'
# Cluster sentinel operating notes

- You are the keeper of this LibrePod cluster. You run as root inside a
  Kata-isolated VM; your Kubernetes access is READ-ONLY (get/list/watch) via
  this pod's ServiceAccount — kubectl works out of the box with in-cluster
  config. You can observe, never mutate.
- /opt/data is your persistent home: sessions, skills, memory, tools and the
  hermes source checkout survive every restart. Everything else (the
  container rootfs, apt-installed packages) is EPHEMERAL — install durable
  tooling under /opt/data, not into /.
- Update yourself only with `hermes update` and only when the user approves.
EOF
fi

cd "$WORKSPACE"

# Web dashboard (management UI: config, keys, sessions, cron, /update),
# env-toggled via DASHBOARD_ENABLED (default on; set "false" for a chat-only
# sentinel). Binding 0.0.0.0 engages hermes's fail-closed auth gate; the
# self-hosted OIDC provider activates from env (HERMES_DASHBOARD_OIDC_ISSUER
# from the app .env, HERMES_DASHBOARD_OIDC_CLIENT_ID from the SSOClient
# secret) — logins go straight to the cluster's Casdoor. Backgrounded here:
# a dead dashboard stays down until the next pod recreation (the gateway is
# unaffected); if the gateway (exec'd below) dies, the container exits and
# k8s restarts both.
if [ "$DASHBOARD_ENABLED" != "false" ]; then
  "$HERMES_BIN" dashboard --host 0.0.0.0 --port 9119 --no-open &
fi

echo "[sentinel] starting gateway"
# Zombie reaping is handled pod-side (shareProcessNamespace: true makes the
# pause container PID 1), so a plain exec is safe here. Do NOT exec
# /usr/bin/tini from this image: it is upstream's tini-SHIM, which brings up
# the whole s6 supervision tree — their services run the image's /opt/hermes
# copy as uid 10000, cannot write this root-owned checkout, and tear the
# container down (verified on dev).
exec "$HERMES_BIN" gateway run
