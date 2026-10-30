#!/usr/bin/env bash
# Test harness for scripts/publish-components.sh. Run from the repo root:
#   bash scripts/test-publish-components.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

# The script derives its root from its own location, so run a copy inside a
# throwaway git repo with two components; the second commit touches only `a`.
T="$TMP/repo"
mkdir -p "$T/scripts" "$T/components/a" "$T/components/b" "$TMP/bin"
cp "$REPO_ROOT/scripts/publish-components.sh" "$T/scripts/"
cat > "$T/components/a/component.yaml" <<'EOF'
spec:
  displayName: "A"
  version: "v1"
EOF
cat > "$T/components/b/component.yaml" <<'EOF'
spec:
  displayName: "B"
  version: "2.0.0"  # comment
EOF
git -C "$T" init -q
git -C "$T" -c user.name=t -c user.email=t@t add -A
git -C "$T" -c user.name=t -c user.email=t@t commit -qm first
echo "# touched" >> "$T/components/a/component.yaml"
git -C "$T" -c user.name=t -c user.email=t@t commit -qam second

# A fake flux proves nothing is pushed without --push.
cat > "$TMP/bin/flux" <<EOF
#!/bin/sh
touch "$TMP/flux-called"
EOF
chmod +x "$TMP/bin/flux"

run() { ( cd "$T" && PATH="$TMP/bin:$PATH" bash scripts/publish-components.sh "$@" ) >"$TMP/out" 2>"$TMP/err" && RC=0 || RC=$?; }

changed_only() {
  run
  [ "$RC" -eq 0 ] || fail "changed_only: exit $RC: $(cat "$TMP/err")"
  grep -q 'components/a:v1 ' "$TMP/out" || fail "changed_only: no a:v1: $(cat "$TMP/out")"
  grep -q 'components/a:latest ' "$TMP/out" || fail "changed_only: no a:latest"
  grep -q 'components/b' "$TMP/out" && fail "changed_only: b was published"
  return 0
}
pr_tag() {
  run --pr 7 a
  [ "$RC" -eq 0 ] || fail "pr_tag: exit $RC"
  grep -q 'components/a:pr-7 ' "$TMP/out" || fail "pr_tag: no a:pr-7"
  [ "$(wc -l < "$TMP/out")" -eq 1 ] || fail "pr_tag: expected one line: $(cat "$TMP/out")"
}
all_strips_comment() {
  run all
  grep -q 'components/b:2.0.0 ' "$TMP/out" || fail "all_strips_comment: $(cat "$TMP/out")"
}
unknown_name() {
  run nope
  [ "$RC" -eq 2 ] || fail "unknown_name: expected exit 2, got $RC"
}
empty_version() {
  sed -i 's/version: "v1"/version: ""/' "$T/components/a/component.yaml"
  run a
  [ "$RC" -eq 1 ] || fail "empty_version: expected exit 1, got $RC"
  sed -i 's/version: ""/version: "v1"/' "$T/components/a/component.yaml"
}
no_push_by_default() {
  rm -f "$TMP/flux-called"
  run all
  [ ! -e "$TMP/flux-called" ] || fail "no_push_by_default: flux was called"
  grep -q '^DRY RUN: flux push artifact oci://' "$TMP/out" || fail "no_push_by_default: no DRY RUN line"
}

for t in changed_only pr_tag all_strips_comment unknown_name empty_version no_push_by_default; do
  "$t"; echo "ok $t"
done
echo PASS
