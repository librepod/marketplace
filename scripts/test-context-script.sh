#!/usr/bin/env sh
# Local test harness for .ai/context-script. Run from repo root.
set -eu

SCRIPT=".ai/context-script"
fail() { echo "FAIL: $1" >&2; exit 1; }

echo "== test 1: unresolved app degrades to a 'not fetched' context, exit 0 =="
out=$(cat .ai/testdata/pr-unresolved.json | sh "$SCRIPT") || fail "script exited non-zero"
echo "$out" | jq -e '.context' >/dev/null 2>&1 || fail "output is not {context:...} JSON"
echo "$out" | jq -r '.context' | grep -q "Release notes NOT auto-fetched" \
  || fail "unresolved case did not degrade with the expected marker"
echo "PASS test 1"

echo "== test 2: a real changed metadata.yaml with a notesRepo hint fetches notes =="
# whoami must already carry a '# serge: notesRepo=traefik/whoami' hint (Task 4).
# Skip gracefully if the hint isn't present yet.
if grep -q '# serge: notesRepo=' apps/whoami/metadata.yaml 2>/dev/null; then
  out=$(cat .ai/testdata/pr-whoami.json | sh "$SCRIPT") || fail "script exited non-zero"
  echo "$out" | jq -r '.context' | grep -qi "whoami bump" || fail "missing 'whoami bump' header"
  echo "PASS test 2"
else
  echo "SKIP test 2 (whoami has no '# serge:' hint yet — run after Task 4)"
fi

echo "ALL TESTS PASSED"
