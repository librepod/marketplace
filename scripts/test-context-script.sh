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

echo "== test 3: malicious notesUrl hint (command injection attempt) is rejected, no side effect, exit 0 =="
# Regression test for the command-injection finding: a metadata.yaml carrying
# a '# serge: notesUrl=...' hint with a shell command substitution must NOT
# be executed. It must degrade to the 'not fetched' marker, exit 0, and must
# not create /tmp/context-script-injection-marker. Network-free: the URL is
# unreachable garbage, so even if validation somehow failed open, curl alone
# cannot execute $(...) — this test proves the shell itself never evals it.
INJECT_APP_DIR="apps/__context-script-test-injection__"
INJECT_MARKER="/tmp/context-script-injection-marker"
rm -f "$INJECT_MARKER"
cleanup_inject_test() { rm -rf "$INJECT_APP_DIR"; rm -f "$INJECT_MARKER"; }
trap cleanup_inject_test EXIT

mkdir -p "$INJECT_APP_DIR"
cp .ai/testdata/malicious-metadata.yaml "$INJECT_APP_DIR/metadata.yaml"

out=$(cat .ai/testdata/pr-malicious-notesurl.json | sh "$SCRIPT") || fail "script exited non-zero on malicious hint"
echo "$out" | jq -e '.context' >/dev/null 2>&1 || fail "malicious-hint output is not {context:...} JSON"
echo "$out" | jq -r '.context' | grep -q "Release notes NOT auto-fetched" \
  || fail "malicious notesUrl was not rejected/degraded"
[ -e "$INJECT_MARKER" ] && fail "INJECTION SUCCEEDED: $INJECT_MARKER was created by the malicious hint"

cleanup_inject_test
trap - EXIT
echo "PASS test 3"

echo "== test 4: notesUrl pointing at a non-GitHub host is rejected before any fetch, exit 0 =="
# Regression test for the token-exfiltration finding: a metadata.yaml
# carrying a '# serge: notesUrl=...' hint whose host is NOT on the GitHub
# allowlist must degrade to the 'not fetched' marker and exit 0. The host
# allowlist check runs before any curl call, so this is network-free even
# though attacker.example.com is a syntactically well-formed, resolvable-
# looking host (unlike test 3's garbage URL).
HOST_TEST_APP_DIR="apps/__context-script-test-non-github-host__"
cleanup_host_test() { rm -rf "$HOST_TEST_APP_DIR"; }
trap cleanup_host_test EXIT

mkdir -p "$HOST_TEST_APP_DIR"
cp .ai/testdata/non-github-notesurl-metadata.yaml "$HOST_TEST_APP_DIR/metadata.yaml"

out=$(cat .ai/testdata/pr-non-github-notesurl.json | sh "$SCRIPT") || fail "script exited non-zero on non-GitHub notesUrl"
echo "$out" | jq -e '.context' >/dev/null 2>&1 || fail "non-GitHub-host output is not {context:...} JSON"
echo "$out" | jq -r '.context' | grep -q "Release notes NOT auto-fetched" \
  || fail "non-GitHub notesUrl host was not rejected/degraded"

cleanup_host_test
trap - EXIT
echo "PASS test 4"

echo "ALL TESTS PASSED"
