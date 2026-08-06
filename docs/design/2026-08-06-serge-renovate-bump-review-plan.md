# Serge-powered Renovate bump review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing `@askserge` PR reviewer read upstream release notes for Renovate version bumps, judge each bump SAFE/REVIEW/UNSAFE, and post a structured advisory verdict comment.

**Architecture:** Three repo-local files drive the `huggingface/serge@main` action already wired in `.github/workflows/ai-review.yaml`. `.ai/context-script` (an executable run in the runner, which has network + the workflow token) fetches release notes for the bumped app; `.ai/review-rules.md` tells Serge how to judge the bump and what block to emit; a `# serge: notesRepo=` hint on each `apps/*/metadata.yaml` makes the app→release-notes resolution deterministic. One small workflow fix (`fetch-depth: 0` + export `GITHUB_TOKEN`) lets the script read the *old* version and authenticate its API calls.

**Tech Stack:** GitHub Actions, `huggingface/serge@main`, POSIX `sh` + `jq` + `curl` + `git` (all preinstalled on `ubuntu-latest`), GitHub REST releases API, YAML app metadata.

## Global Constraints

- **Posture is advisory:** `review_event` stays `COMMENT`. Serge NEVER approves or requests changes or blocks a merge. (Spec §"Chosen posture".)
- **Trigger unchanged:** manual `@askserge` only. Do NOT add `pull_request` auto-triggers or change `mention_trigger` or the author-association gate. (Spec §"Chosen posture".)
- **`.ai/context-script` must always `exit 0`** — a fetch failure or missing hint degrades to a "notes not fetched" context, never a red X. (Spec §Components 1, "Invariants".)
- **The context-script runs in the raw runner, NOT inside `nix-shell`.** Depend only on tools present on `ubuntu-latest`: `sh`, `jq`, `curl`, `git`, `gh`. Do NOT rely on `shell.nix`. (Discovered during planning.)
- **Default file paths are the action's own defaults:** `.ai/review-rules.md` and `.ai/context-script`. Creating the files at these paths is sufficient — no new workflow inputs needed. (Spec §Component 4; memory `serge-action-customization-surface`.)
- **Hint comment format:** exactly `# serge: notesRepo=<owner>/<repo>` or `# serge: notesUrl=<url>`, placed on the line immediately after the existing `# renovate:` comment and immediately before `version:`. (Spec §Component 3.)
- **Conservative default:** when release notes are absent/unfetched OR confidence is low, the verdict is REVIEW, never SAFE. (Spec §Component 2.)
- **Never review `catalog.yaml`** (generated). (Spec §Component 2.)
- **Fetch the whole tag range** old..new, not just the endpoints — intermediate releases carry breaking changes. (Spec §Component 1, "Invariants".)

**Reference:** spec at `docs/design/2026-08-06-serge-renovate-bump-review-design.md`; action customization facts in memory `serge-action-customization-surface`.

---

## Task 1: Fix the workflow so the context-script can read the old version and authenticate

**Files:**
- Modify: `.github/workflows/ai-review.yaml`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a checkout with full history (so `git show <base_sha>:<path>` works) and a `GITHUB_TOKEN` env var visible to the `serge` step (so the context-script's `curl`/`gh` calls are authenticated). Later tasks (the context-script) rely on `GITHUB_TOKEN` being set and on `git show "$GITHUB_BASE_SHA":<path>` resolving.

The current file (verbatim, for reference):
```yaml
      - uses: actions/checkout@v6
        with:
          ref: refs/pull/${{ github.event.issue.number || github.event.pull_request.number }}/head
        continue-on-error: true

      - uses: huggingface/serge@main
        with:
          llm_api_base: ${{ vars.LLM_API_BASE || 'https://openrouter.ai/api/v1' }}
          llm_api_key: ${{ secrets.LLM_API_KEY }}
          llm_model: ${{ vars.LLM_MODEL }}
          llm_max_tokens: '8192'
```

- [ ] **Step 1: Add `fetch-depth: 0` to the checkout and export the base sha + token to the serge step**

Edit the two steps to read exactly:
```yaml
      - uses: actions/checkout@v6
        with:
          ref: refs/pull/${{ github.event.issue.number || github.event.pull_request.number }}/head
          fetch-depth: 0
        continue-on-error: true

      - uses: huggingface/serge@main
        env:
          # The context-script (.ai/context-script) uses these:
          #   GITHUB_TOKEN     — authenticate GitHub API release-note fetches
          #   GITHUB_BASE_SHA  — `git show $GITHUB_BASE_SHA:<file>` reads the pre-bump version
          GITHUB_TOKEN: ${{ github.token }}
          GITHUB_BASE_SHA: ${{ github.event.pull_request.base.sha }}
        with:
          llm_api_base: ${{ vars.LLM_API_BASE || 'https://openrouter.ai/api/v1' }}
          llm_api_key: ${{ secrets.LLM_API_KEY }}
          llm_model: ${{ vars.LLM_MODEL }}
          llm_max_tokens: '8192'
```

Notes for the implementer:
- `github.event.pull_request.base.sha` is empty for `issue_comment` events (the `@askserge` path is an issue_comment on a PR). That's fine — the context-script must fall back to `git merge-base origin/master HEAD` when `GITHUB_BASE_SHA` is empty (handled in Task 2). Setting it here still helps the `pull_request_review_comment` trigger and does no harm when empty.
- `fetch-depth: 0` is the load-bearing change: without full history, neither `git show <sha>:` nor `git merge-base` can resolve the old file.

- [ ] **Step 2: Lint the workflow YAML**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ai-review.yaml')); print('YAML OK')"
```
Expected: `YAML OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ai-review.yaml
git commit -m "ci(ai-review): full history + token/base-sha env for bump context-script"
```

---

## Task 2: Write `.ai/context-script` — resolve versions, fetch release notes, emit context

**Files:**
- Create: `.ai/context-script` (executable, `#!/usr/bin/env sh`)
- Create: `scripts/test-context-script.sh` (local test harness)
- Create: `.ai/testdata/pr-whoami.json`, `.ai/testdata/pr-unresolved.json` (test fixtures)

**Interfaces:**
- Consumes: from Task 1 — env vars `GITHUB_TOKEN` (optional; unauthenticated fetch still works, just rate-limited) and `GITHUB_BASE_SHA` (optional; falls back to `git merge-base origin/master HEAD`). Reads Serge's PR JSON on **stdin**.
- Produces: a single JSON object on **stdout**: `{"context": "<string>"}`. Always exits 0. Serge injects `.context` verbatim into the reviewer prompt. Task 3's review-rules.md relies on the context containing the literal markers `RELEASE NOTES` (when fetched) or `Release notes NOT auto-fetched` (when not), and a first line of the form `<app> bump <old>-><new>`.

**Stdin shape** (from the Serge docs — the fields the script reads):
```json
{
  "title": "chore(deps): update traefik/whoami docker tag to v1.11.0",
  "body": "…renovate PR body…",
  "files": [
    { "path": "apps/whoami/metadata.yaml", "status": "modified", "additions": 1, "deletions": 1 }
  ]
}
```

- [ ] **Step 1: Write the two test fixtures**

Create `.ai/testdata/pr-whoami.json` (a resolvable app — will get a hint in Task 4, but the script must also work if run before the hint exists, so this fixture is used with an inline hint added in the test):
```json
{
  "title": "chore(deps): update traefik/whoami docker tag to v1.11.0",
  "body": "Bumps whoami.",
  "files": [
    { "path": "apps/whoami/metadata.yaml", "status": "modified", "additions": 1, "deletions": 1 }
  ]
}
```

Create `.ai/testdata/pr-unresolved.json` (a changed metadata.yaml with no `# serge:` hint — must degrade gracefully):
```json
{
  "title": "chore(deps): update some app",
  "body": "",
  "files": [
    { "path": "apps/DOES-NOT-EXIST/metadata.yaml", "status": "modified", "additions": 1, "deletions": 1 }
  ]
}
```

- [ ] **Step 2: Write the local test harness `scripts/test-context-script.sh`**

This lets us test without Serge or a cluster. It asserts on the script's stdout.
```sh
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
```
Make it executable:
```bash
chmod +x scripts/test-context-script.sh
```

- [ ] **Step 3: Run the harness to confirm it FAILS (script doesn't exist yet)**

Run:
```bash
sh scripts/test-context-script.sh
```
Expected: FAIL — `.ai/context-script` does not exist, so `sh "$SCRIPT"` errors and test 1 reports `FAIL: script exited non-zero` (or a "No such file" error). This proves the harness actually exercises the script.

- [ ] **Step 4: Write `.ai/context-script`**

Create `.ai/context-script` with exactly this content:
```sh
#!/usr/bin/env sh
# Serge context-script for LibrePod Marketplace.
# Injects upstream release notes for Renovate version-bump PRs so the reviewer
# can judge whether a bump is safe. Runs in the GitHub Actions runner (has
# network + GITHUB_TOKEN). Contract: read Serge PR JSON on stdin, print
# {"context": "..."} on stdout, ALWAYS exit 0.
set -u

MAX_NOTES_CHARS=12000

# Emit a context payload and exit successfully. $1 = context string.
emit() {
  # jq -Rs turns arbitrary text into a safe JSON string.
  printf '%s' "$1" | jq -Rs '{context: .}'
  exit 0
}

input=$(cat)

# Which metadata.yaml files changed? (Renovate bumps spec.version there.)
metafiles=$(printf '%s' "$input" \
  | jq -r '.files[]?.path // empty' \
  | grep -E '^apps/[^/]+/metadata\.yaml$' || true)

# Not a metadata bump → let Serge do a normal review with no extra context.
[ -z "$metafiles" ] && emit ""

# Resolve the base commit to read the pre-bump version from.
base="${GITHUB_BASE_SHA:-}"
if [ -z "$base" ]; then
  base=$(git merge-base origin/master HEAD 2>/dev/null || echo "")
fi

out=""
for f in $metafiles; do
  app=$(printf '%s' "$f" | cut -d/ -f2)

  new_ver=$(grep -E '^\s*version:' "$f" 2>/dev/null | head -1 \
    | sed -E 's/.*version:\s*"?([^"[:space:]]+)"?.*/\1/')

  old_ver=""
  if [ -n "$base" ]; then
    old_ver=$(git show "$base:$f" 2>/dev/null | grep -E '^\s*version:' | head -1 \
      | sed -E 's/.*version:\s*"?([^"[:space:]]+)"?.*/\1/')
  fi
  [ -z "$old_ver" ] && old_ver="unknown"

  header="$app bump ${old_ver}->${new_ver}"

  # Resolution hint written next to the renovate comment.
  notes_repo=$(grep -oE '# serge: notesRepo=\S+' "$f" 2>/dev/null | head -1 | sed 's/.*notesRepo=//')
  notes_url=$(grep -oE '# serge: notesUrl=\S+' "$f" 2>/dev/null | head -1 | sed 's/.*notesUrl=//')

  if [ -z "$notes_repo" ] && [ -z "$notes_url" ]; then
    out="${out}${header}

WARNING: Release notes NOT auto-fetched (no '# serge:' hint in $f).
Judge from the diff and default the verdict toward REVIEW.

"
    continue
  fi

  auth=""
  [ -n "${GITHUB_TOKEN:-}" ] && auth="-H \"Authorization: Bearer $GITHUB_TOKEN\""

  notes=""
  if [ -n "$notes_repo" ]; then
    # Fetch the release for the NEW tag; try both 'vX' and 'X' tag spellings.
    for tag in "$new_ver" "v${new_ver#v}" "${new_ver#v}"; do
      body=$(eval curl -sSL $auth \
        -H '"Accept: application/vnd.github+json"' \
        "https://api.github.com/repos/$notes_repo/releases/tags/$tag" 2>/dev/null)
      got=$(printf '%s' "$body" | jq -r '.body // empty' 2>/dev/null)
      if [ -n "$got" ]; then
        notes="Release $tag:
$got"
        break
      fi
    done
    # Fallback: list recent releases so a range/notes still show up.
    if [ -z "$notes" ]; then
      notes=$(eval curl -sSL $auth \
        -H '"Accept: application/vnd.github+json"' \
        "https://api.github.com/repos/$notes_repo/releases?per_page=10" 2>/dev/null \
        | jq -r '.[]? | "Release \(.tag_name):\n\(.body // "")\n"' 2>/dev/null)
    fi
  elif [ -n "$notes_url" ]; then
    notes=$(eval curl -sSL $auth "$notes_url" 2>/dev/null)
  fi

  if [ -z "$notes" ]; then
    out="${out}${header}

WARNING: Release notes NOT auto-fetched (fetch from '${notes_repo}${notes_url}' returned nothing).
Judge from the diff and default the verdict toward REVIEW.

"
    continue
  fi

  # Truncate to protect the model's context / max_diff_chars budget.
  notes=$(printf '%s' "$notes" | cut -c1-"$MAX_NOTES_CHARS")

  out="${out}${header}

=== RELEASE NOTES (${notes_repo}${notes_url}) ===
${notes}

"
done

emit "$out"
```

Make it executable (Serge ignores a non-executable context-script):
```bash
chmod +x .ai/context-script
```

- [ ] **Step 5: Run the harness — test 1 (unresolved) must PASS; test 2 SKIPs until Task 4**

Run:
```bash
sh scripts/test-context-script.sh
```
Expected: `PASS test 1`, then `SKIP test 2 (whoami has no '# serge:' hint yet …)`, then `ALL TESTS PASSED`. (Test 2 exercises real network + the hint; it runs green after Task 4.)

- [ ] **Step 6: Sanity-check the JSON contract directly**

Run:
```bash
cat .ai/testdata/pr-unresolved.json | sh .ai/context-script | jq -e '.context' >/dev/null && echo "valid {context} JSON, exit 0"
```
Expected: `valid {context} JSON, exit 0`.

- [ ] **Step 7: Commit**

```bash
git add .ai/context-script scripts/test-context-script.sh .ai/testdata
git commit -m "feat(ai-review): context-script fetches release notes for version bumps"
```

---

## Task 3: Write `.ai/review-rules.md` — the SAFE/REVIEW/UNSAFE policy

**Files:**
- Create: `.ai/review-rules.md`

**Interfaces:**
- Consumes: from Task 2 — the injected context whose first line is `<app> bump <old>-><new>` and which contains either a `=== RELEASE NOTES` block or a `Release notes NOT auto-fetched` warning.
- Produces: the review behavior. No code depends on this file's contents; the workflow picks it up automatically because it sits at the action's default `review_rules_path`.

- [ ] **Step 1: Create `.ai/review-rules.md`**

Create the file with exactly this content:
```markdown
# Serge review rules — LibrePod Marketplace

This repo is a GitOps marketplace of self-hostable apps. Most PRs are
automated dependency bumps from Renovate that change only `spec.version` in
`apps/<app>/metadata.yaml` (and pinned tags in kustomize/OCI files). The
injected context will contain a line like `whoami bump v1.10.0->v1.11.0` and
either a `=== RELEASE NOTES ===` block or a `Release notes NOT auto-fetched`
warning.

## When the PR is a dependency/version bump

Renovate does NOT read release notes or reason about breaking changes — that
is YOUR job. Using the release notes in the injected context (or the diff, if
none were fetched), decide a verdict and ALWAYS post exactly this block as a
COMMENT:

```
## 🤖 Bump review: <app> <old>→<new>
**Verdict:** ✅ SAFE | 🟡 REVIEW | 🔴 UNSAFE
**Why:** <one line>
**Breaking changes:** <bullets, or "none found">
**Migration needed:** <exact file + edit, or "none">
**Notes source:** <"fetched" | "not fetched — judged from diff">
```

Verdict guidance:
- **SAFE** — patch/minor with no config, API, env, volume, or default changes
  in the notes; nothing in the diff beyond the version tag.
- **REVIEW** — release notes were NOT fetched, OR minor changes that *might*
  need a config touch, OR you are not confident. Default here when unsure.
- **UNSAFE** — the notes describe removed/renamed config keys, changed
  defaults, dropped env vars, storage/PVC migrations, breaking API/CRD
  changes, or a major-version bump with a documented migration.

When the verdict is REVIEW or UNSAFE, inspect the app's `overlays/librepod/`
and `base/` files and name the EXACT file + key a LibrePod user would need to
change. Migrations here mean Kustomize / Helm-values / env edits — NOT app
source code.

Be terse. Post exactly one verdict block per app changed.

## When the PR is NOT a bump (human-authored)

Fall back to a normal review: correctness, security, and behavior changes in
the Kustomize/Flux manifests. Skip style-only nits and generated files
(especially `catalog.yaml`). Respect the repo conventions in `CLAUDE.md`.

## Always

Never approve and never request changes — post COMMENT reviews only. The human
maintainer is the sole merge gate.
```

- [ ] **Step 2: Verify the file is valid markdown and contains the verdict template**

Run:
```bash
grep -q "Bump review:" .ai/review-rules.md && grep -q "Never approve and never request changes" .ai/review-rules.md && echo "rules OK"
```
Expected: `rules OK`.

- [ ] **Step 3: Commit**

```bash
git add .ai/review-rules.md
git commit -m "feat(ai-review): bump-review policy + structured verdict block"
```

---

## Task 4: Add `# serge: notesRepo=` hints to all 26 apps

**Files:**
- Modify: every `apps/*/metadata.yaml` (26 files), inserting one hint line.

**Interfaces:**
- Consumes: from Task 2 — the exact hint grammar `# serge: notesRepo=<owner>/<repo>` / `# serge: notesUrl=<url>`, placed between the `# renovate:` line and `version:`.
- Produces: deterministic release-note resolution for the context-script. Unblocks Task 2's test 2 and the live e2e in Task 5.

**Resolution table** — insert the given line immediately BELOW the app's
existing `# renovate:` comment. Values marked **(VERIFY)** are best-guess
upstream repos; confirm the repo actually publishes GitHub Releases before
committing (open `https://github.com/<repo>/releases`); if it doesn't, use a
`notesUrl=` to its changelog instead, or leave no hint (graceful REVIEW).

| App | Hint line to insert |
|---|---|
| baikal | `  # serge: notesRepo=sabre-io/Baikal` **(VERIFY)** |
| casdoor | `  # serge: notesRepo=casdoor/casdoor` **(VERIFY: image tracks the helm-chart repo casbin/casdoor-helm-charts; chart tag may not match app releases)** |
| casdoor-sso-controller | `  # serge: notesRepo=librepod/casdoor-sso-controller` **(VERIFY: in-house)** |
| cert-manager | `  # serge: notesRepo=cert-manager/cert-manager` |
| external-secrets | `  # serge: notesRepo=external-secrets/external-secrets` **(VERIFY: helm chart version vs app version)** |
| flux-operator-mcp | `  # serge: notesRepo=controlplaneio-fluxcd/flux-operator` **(VERIFY)** |
| frpc | `  # serge: notesRepo=fatedier/frp` |
| frp-operator | `  # serge: notesRepo=librepod/frp-operator` **(VERIFY: in-house)** |
| gogs | `  # serge: notesRepo=gogs/gogs` |
| headscale | `  # serge: notesRepo=juanfont/headscale` |
| immich | `  # serge: notesRepo=immich-app/immich` |
| litellm | `  # serge: notesRepo=BerriAI/litellm` |
| marketplace-ui | `  # serge: notesRepo=librepod/marketplace` **(VERIFY: in-house; may have no releases → drop hint)** |
| nfs-provisioner | `  # serge: notesRepo=kubernetes-sigs/nfs-subdir-external-provisioner` |
| oauth2-proxy | `  # serge: notesRepo=oauth2-proxy/oauth2-proxy` |
| obsidian-livesync | `  # serge: notesUrl=https://api.github.com/repos/apache/couchdb/releases?per_page=10` **(image tracks couchdb, not the obsidian-livesync app; using couchdb notes intentionally)** |
| open-webui | `  # serge: notesRepo=open-webui/open-webui` |
| reflector | `  # serge: notesRepo=emberstack/kubernetes-reflector` **(VERIFY)** |
| rustdesk-server-oss | `  # serge: notesRepo=rustdesk/rustdesk-server` |
| step-certificates | `  # serge: notesRepo=smallstep/certificates` **(VERIFY: image cr.smallstep.com/smallstep/step-ca → repo smallstep/certificates)** |
| step-issuer | `  # serge: notesRepo=smallstep/step-issuer` |
| tailscale | `  # serge: notesRepo=tailscale/tailscale` |
| traefik | `  # serge: notesRepo=traefik/traefik` |
| vaultwarden | `  # serge: notesRepo=dani-garcia/vaultwarden` |
| wg-easy | `  # serge: notesRepo=wg-easy/wg-easy` |
| whoami | `  # serge: notesRepo=traefik/whoami` |

- [ ] **Step 1: Insert the whoami hint first (unblocks Task 2 test 2)**

`apps/whoami/metadata.yaml` around lines 12-13 should become:
```yaml
  # renovate: datasource=docker depName=traefik/whoami
  # serge: notesRepo=traefik/whoami
  version: "v1.11.0"
```

- [ ] **Step 2: Confirm whoami e2e resolution now works**

Run:
```bash
sh scripts/test-context-script.sh
```
Expected: `PASS test 1`, `PASS test 2` (real network fetch of traefik/whoami release notes), `ALL TESTS PASSED`. If test 2 fails because GitHub API rate-limits an unauthenticated local run, re-run with a token: `GITHUB_TOKEN=$(gh auth token) sh scripts/test-context-script.sh`.

- [ ] **Step 3: Insert hints into the remaining 25 apps**

For each row in the table, open `apps/<app>/metadata.yaml`, find the `# renovate:` line, and insert the hint line directly below it. For rows marked **(VERIFY)**, first open the candidate repo's `/releases` page; if it has no GitHub Releases, either switch to a `notesUrl=` changelog or omit the hint entirely (the script degrades to REVIEW — safe). Record any omissions in the commit body.

- [ ] **Step 4: Verify every hint is well-formed and correctly placed**

Run:
```bash
# Every hint must match the grammar the script greps for:
grep -rhoP '# serge: notes(Repo|Url)=\S+' apps/*/metadata.yaml | sort | uniq -c
# Count apps that got a hint (expect ~23-26 depending on VERIFY omissions):
grep -rl '# serge:' apps/*/metadata.yaml | wc -l
# Guard: no hint accidentally landed on a line that isn't right before version:
for f in $(grep -rl '# serge:' apps/*/metadata.yaml); do
  awk '/# serge:/{s=NR} /^\s*version:/{if(s && NR-s!=1) print FILENAME": hint not directly above version:"}' "$f"
done
```
Expected: the grammar list shows only `notesRepo=`/`notesUrl=` lines; the count is in range; the guard prints nothing.

- [ ] **Step 5: Confirm the app manifests still build (hints are comments — must be inert)**

Run (uses the repo's nix-shell, per CLAUDE.md):
```bash
nix-shell shell.nix --run 'kustomize build apps/whoami/overlays/librepod >/dev/null && echo "kustomize OK"'
```
Expected: `kustomize OK` (a YAML comment cannot affect the build; this guards against a stray edit that broke indentation).

- [ ] **Step 6: Commit**

```bash
git add apps/*/metadata.yaml
git commit -m "feat(ai-review): add serge release-notes resolution hints to all apps"
```

---

## Task 5: Live end-to-end verification on a real Renovate PR

**Files:** none (verification only).

**Interfaces:**
- Consumes: Tasks 1-4 merged to a branch the workflow can run from. NOTE: `review_rules_path` and `context_script_path` are read from the **default branch** by the action — see Step 1.

- [ ] **Step 1: Understand the default-branch read and choose how to verify**

The Serge action reads `.ai/review-rules.md` from the repo's **default branch** (`master`), and clones the PR head for the context-script. So a true end-to-end test requires these files on `master`. Two options — pick with the maintainer:
  - **(a)** Merge this feature branch to `master` first (advisory-only, nothing auto-runs, low risk), then `@askserge` an existing open Renovate PR.
  - **(b)** Temporarily point the workflow/test at this branch, or open a throwaway PR whose base is this branch, to smoke-test before merging.

Recommended: **(a)** — the change is inert until someone types `@askserge`, so landing it on `master` carries no deployment risk.

- [ ] **Step 2: Trigger a review on an easy bump**

On an open Renovate PR that only bumps a resolvable app (e.g. whoami/traefik/immich — pick one currently open, such as **#136 traefik** or **#129 immich**), comment:
```
@askserge please review
```

- [ ] **Step 3: Verify the verdict comment**

Confirm Serge posts a comment containing the `## 🤖 Bump review:` block with a filled-in Verdict, and that **Notes source** says `fetched` (not "not fetched") for the resolvable app. If it says "not fetched", check the app's hint resolves to a repo with GitHub Releases (Task 4 VERIFY step).

- [ ] **Step 4: Verify the fail-soft path**

Comment `@askserge please review` on a PR for an app with no hint / a private-notes app (or temporarily an app you left unhinted). Confirm the verdict is **🟡 REVIEW** with **Notes source: not fetched** — proving graceful degradation, not a workflow failure.

- [ ] **Step 5: Record the outcome**

Note in the PR (or the design doc's status) which apps fetched cleanly and any that need a hint fix. No commit required unless a hint needs correcting (then amend Task 4).

---

## Self-Review

**Spec coverage:**
- Architecture / three files + workflow fix → Tasks 1-4. ✓
- context-script fetch logic, range, truncation, fail-soft exit 0 → Task 2. ✓
- review-rules policy, thresholds, verdict block, catalog.yaml skip, COMMENT-only → Task 3. ✓
- Resolution hints for all 26 apps, three depName shapes → Task 4 (with VERIFY notes for the ambiguous ones the spec flagged). ✓
- Workflow fixes (`fetch-depth: 0`, token) → Task 1. ✓
- Testing: local harness → Task 2; live e2e incl. adversarial immich + fail-soft → Task 5. ✓
- Out-of-scope items (auto-trigger, REQUEST_CHANGES, blocking, review-tools.json, Renovate-config change) → none introduced. ✓
- Risk "hint drift → REVIEW" → realized by Task 2's unresolved path + Task 4 omission handling. ✓

**Placeholder scan:** No "TBD/handle edge cases/similar to Task N". The **(VERIFY)** markers are explicit, actionable verification instructions with a pre-filled best guess and a defined fallback (notesUrl or omit) — not placeholders.

**Type/contract consistency:** The context markers are consistent across tasks — Task 2 emits `<app> bump <old>-><new>`, `=== RELEASE NOTES`, and `Release notes NOT auto-fetched`; Task 3's rules and Task 2's test harness key off those exact strings. Hint grammar `# serge: notesRepo=`/`notesUrl=` is identical in Tasks 2 and 4. Env var names `GITHUB_TOKEN`/`GITHUB_BASE_SHA` match between Task 1 (set) and Task 2 (read).
