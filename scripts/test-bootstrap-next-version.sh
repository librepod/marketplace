#!/usr/bin/env bash
# Tests for scripts/bootstrap-next-version.sh. Run from anywhere:
#   bash scripts/test-bootstrap-next-version.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLASSIFIER="$SCRIPT_DIR/bootstrap-next-version.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }

git_setup() {
  git -C "$TMP" init -q -b main
  git -C "$TMP" config user.email test@local
  git -C "$TMP" config user.name test
}
commit_all() { git -C "$TMP" add -A && git -C "$TMP" commit -qm "${1:-wip}"; }
release() { git -C "$TMP" tag "marketplace-bootstrap-v$1"; }

pin_file() {  # pin_file <app> <tag>
  mkdir -p "$TMP/infrastructure/system-apps"
  printf 'apiVersion: source.toolkit.fluxcd.io/v1\nkind: OCIRepository\nspec:\n  ref:\n    tag: "%s"\n' \
    "$2" > "$TMP/infrastructure/system-apps/$1.yaml"
}

run_classifier() { (cd "$TMP" && bash "$CLASSIFIER"); }
next_of() { run_classifier | head -n1; }
notes_of() { run_classifier | tail -n +3; }

git_setup
pin_file traefik "3.7.10"
pin_file marketplace-ui "0.10.0"
pin_file marketplace-catalog "latest"   # float: must never appear in notes
mkdir -p "$TMP/clusters"
commit_all "seed"
release 0.3.2

# 1. patch bump
pin_file traefik "3.7.11"; commit_all "traefik patch"
[ "$(next_of)" = "NEXT=0.3.3" ] || fail "1: expected NEXT=0.3.3, got $(next_of)"
notes_of | grep -qF 'traefik 3.7.10->3.7.11 [patch]' || fail "1: patch note missing"
release 0.3.3

# 2. minor bump
pin_file marketplace-ui "0.11.0"; commit_all "ui minor"
[ "$(next_of)" = "NEXT=0.4.0" ] || fail "2: expected NEXT=0.4.0, got $(next_of)"
notes_of | grep -qF 'marketplace-ui 0.10.0->0.11.0 [minor]' || fail "2: minor note missing"
release 0.4.0

# 3. max level wins within one window (patch + major -> major)
pin_file marketplace-ui "0.11.1"
pin_file traefik "4.0.0"; commit_all "mixed"
[ "$(next_of)" = "NEXT=1.0.0" ] || fail "3: expected NEXT=1.0.0, got $(next_of)"
notes_of | grep -qF 'marketplace-ui 0.11.0->0.11.1 [patch]' || fail "3: patch note missing"
notes_of | grep -qF 'traefik 3.7.11->4.0.0 [major]' || fail "3: major note missing"
release 1.0.0

# 4. rollback -> patch, flagged
pin_file traefik "3.7.11"; commit_all "rollback"
[ "$(next_of)" = "NEXT=1.0.1" ] || fail "4: expected NEXT=1.0.1, got $(next_of)"
notes_of | grep -qF 'traefik 4.0.0->3.7.11 [patch, rollback]' || fail "4: rollback note missing"
release 1.0.1

# 5a. new system app -> minor
pin_file frpc "v0.65.0"; commit_all "add frpc"
[ "$(next_of)" = "NEXT=1.1.0" ] || fail "5a: expected NEXT=1.1.0, got $(next_of)"
notes_of | grep -qF 'frpc added [minor]' || fail "5a: added note missing"
release 1.1.0

# 5b. v-prefix bump -> minor (first differing segment after v-strip), no v in notes
pin_file frpc "v0.66.0"; commit_all "frpc bump"
[ "$(next_of)" = "NEXT=1.2.0" ] || fail "5b: expected NEXT=1.2.0, got $(next_of)"
notes_of | grep -qF 'frpc 0.65.0->0.66.0 [minor]' || fail "5b: v-prefix note missing"
release 1.2.0

# 6. removed system app -> minor
rm -f "$TMP/infrastructure/system-apps/frpc.yaml"; commit_all "remove frpc"
[ "$(next_of)" = "NEXT=1.3.0" ] || fail "6: expected NEXT=1.3.0, got $(next_of)"
notes_of | grep -qF 'frpc removed [minor]' || fail "6: removed note missing"
release 1.3.0

# 7. non-pin infrastructure edit -> default patch
printf '# comment\n' >> "$TMP/infrastructure/system-apps/traefik.yaml"; commit_all "comment"
[ "$(next_of)" = "NEXT=1.3.1" ] || fail "7: expected NEXT=1.3.1, got $(next_of)"
notes_of | grep -qF 'no pin changes (non-pin infrastructure edit) [patch]' || fail "7: default note missing"
release 1.3.1

# 8. clusters/ edit (no infrastructure change) -> default patch
printf '# comment\n' >> "$TMP/clusters/notes.txt"; commit_all "clusters edit"
[ "$(next_of)" = "NEXT=1.3.2" ] || fail "8: expected NEXT=1.3.2, got $(next_of)"
release 1.3.2

# 9. no diff since last release -> empty NEXT (skip)
[ "$(next_of)" = "NEXT=" ] || fail "9: expected empty NEXT, got $(next_of)"

# 10. cosmetic quote change normalizes to equal -> not a pin change, default patch
sed -i 's/tag: "3.7.11"/tag: 3.7.11/' "$TMP/infrastructure/system-apps/traefik.yaml"
commit_all "unquote"
[ "$(next_of)" = "NEXT=1.3.3" ] || fail "10: expected NEXT=1.3.3, got $(next_of)"
notes_of | grep -qF 'no pin changes' || fail "10: cosmetic change should be default patch"

# 11. catalog float never recorded
if notes_of | grep -q marketplace-catalog; then fail "11: catalog float appeared in notes"; fi

# 12. no release tags at all -> hard error
TMP2="$(mktemp -d)"; trap 'rm -rf "$TMP" "$TMP2"' EXIT
git -C "$TMP2" init -q -b main
git -C "$TMP2" config user.email test@local; git -C "$TMP2" config user.name test
if (cd "$TMP2" && bash "$CLASSIFIER") >/dev/null 2>&1; then fail "12: expected failure without tags"; fi

echo "PASS: all bootstrap-next-version scenarios"
