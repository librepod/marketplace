#!/usr/bin/env bash
# Tier 1 orchestrator: build client+server → bring up seeded Gogs → verify
# readiness → run Playwright → tear down Gogs. Extra args ("$@") are forwarded
# to `playwright test` (e.g. a spec path filter).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Script lives in ui/packages/e2e/support/ — three levels below the ui/ root.
UI_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE="$UI_ROOT/packages/e2e/docker-compose.e2e.yml"
E2E="$UI_ROOT/packages/e2e"

cleanup() {
  echo "==> Tearing down Gogs"
  docker compose -f "$COMPOSE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$UI_ROOT"

echo "==> Building client + server"
npm run build:client
npm run build

echo "==> Starting Gogs (seeded runtime)"
# Detached, deliberately WITHOUT --wait: gogs-seed is a one-shot with no
# healthcheck, and `up --wait` rejects healthcheck-less services on some docker
# compose versions (CI's standard build, though not the local one). gogs-ready.mjs
# below POLLS until gogs is up AND the seed completes, so it is the real readiness
# gate. depends_on still orders gogs-init → gogs → gogs-seed regardless of --wait.
docker compose -f "$COMPOSE" up -d

echo "==> Verifying Gogs readiness"
GOGS_URL="http://127.0.0.1:43000" GOGS_USERNAME="flux" GOGS_TOKEN="pass@w0rd" \
  node "$E2E/support/gogs-ready.mjs"

echo "==> Running Playwright (Tier 1)"
npx playwright test --config "$E2E/projects/tier1.config.ts" "$@"
