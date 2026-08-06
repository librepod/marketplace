# Serge-powered review of Renovate version bumps — design

**Date:** 2026-08-06
**Status:** Approved (brainstorm), pending implementation plan
**Author:** Alex Sukhov (with Claude)

## Problem

Renovate opens PRs that bump `spec.version` in `apps/<app>/metadata.yaml`
(and the pinned image/chart tags). By design Renovate is a "dumb" bumper: it
does **not** read upstream release notes, reason about breaking changes, or
say whether a bump is safe to merge. For a marketplace of self-hostable apps,
a silent breaking bump can break a user's install (dropped config keys,
changed defaults, storage migrations, CRD changes).

We want each Renovate PR to receive an AI assessment that reads the upstream
release notes, judges whether the bump is safe, flags breaking changes, and —
when needed — points at the exact Kustomize/Helm/env edit a migration
requires.

## Constraint discovery (why this design)

The repo already has `.github/workflows/ai-review.yaml`, which runs the
`huggingface/serge@main` action on an `@askserge` comment. Research into that
action's customization surface (recorded in memory
`serge-action-customization-surface`) found it is purpose-built for exactly
this:

- **`.ai/review-rules.md`** — markdown policy injected into the reviewer's
  prompt (read from the default branch). Where the bump-review policy lives.
- **`.ai/context-script`** — an executable run in the workflow runner (**has
  network** + can use the workflow token). Receives PR title/body + changed
  files as JSON on stdin; prints text injected as review context. **This is
  the only place network fetching can happen** — the reviewer LLM has no
  web-fetch tool, and `.ai/review-tools.json` helper commands run in a
  no-network, no-shell sandbox.
- `mention_trigger` (default `@askserge`) and `review_event`
  (COMMENT | REQUEST_CHANGES | APPROVE) are configurable.

So no second tool is needed. The design fills three files and makes one small
correctness fix to the existing workflow.

## Chosen posture (deliberately conservative)

| Decision | Choice | Rationale |
|---|---|---|
| Trigger | Manual `@askserge` (unchanged) | Human stays in control; no auto-magic to debug first. |
| Enforcement | COMMENT only (advisory) | Never blocks a merge; no false-positive friction. User is sole gate. |
| Release-note source | Derive from `metadata.yaml`, via explicit hints | Deterministic for all 26 apps (depName→repo guessing is unreliable for ~2/3). |
| Verdict format | Structured block (SAFE/REVIEW/UNSAFE) | Skimmable across 20+ open PRs. |

All escalations (auto-trigger, `REQUEST_CHANGES`, required-check blocking) are
one-line changes deferred until the advisory version earns trust. YAGNI.

## Architecture & data flow

```
Renovate opens PR #NNN (bumps spec.version in apps/<app>/metadata.yaml)
        │  human comments "@askserge please review"
        ▼
.github/workflows/ai-review.yaml   (existing; small fixes below)
        │
        ├─ (1) .ai/context-script  [runner: HAS network + GITHUB token]
        │        stdin JSON: { title, body, files[] }
        │        • find changed apps/<app>/metadata.yaml
        │        • old→new spec.version (new = file, old = git show base:)
        │        • read "# serge: notesRepo=<owner>/<repo>" hint
        │        • fetch release notes for the target (new) tag via GitHub
        │          API, with a recent-releases fallback (not a full range-walk)
        │        • print { "context": "<app> v_old→v_new\n\n<notes|note>" }
        │        • FAIL-SOFT: on any miss, emit a "notes not fetched" context, exit 0
        │
        ├─ (2) .ai/review-rules.md  [policy injected into prompt]
        │        bump-review instructions + structured verdict block
        │
        ▼
Serge LLM  →  ONE structured verdict COMMENT (advisory; never blocks)
```

Division of labor: **context-script fetches** (LLM can't), **review-rules
sets policy + output shape**, **Serge reasons**.

## Components

### 1. `.ai/context-script` (executable; POSIX sh + jq + gh/curl)

**Input:** JSON on stdin — `{ title, body, files: [{ path, status,
additions, deletions, previous_path }] }`.

**Logic:**
1. Select `files[].path` matching `apps/*/metadata.yaml` (usually one —
   Renovate groups per app).
2. Resolve old→new `spec.version`: **new** from the checked-out file, **old**
   via `git show <base_sha>:<path>`. Fall back to diff parsing if git is
   unavailable.
3. Read the app's resolution hint from the metadata comment:
   `# serge: notesRepo=<owner>/<repo>` (GitHub), with optional
   `notesUrl=<url>` for non-GitHub changelogs.
4. Fetch release notes for the target (new) tag via the GitHub releases API
   (`GET /repos/{owner}/{repo}/releases/tags/{tag}`), authenticated with the
   workflow token; try a couple of tag spellings (`v1.2.3` / `1.2.3`). If
   that misses, fall back to a recent-releases list (`GET
   /repos/{owner}/{repo}/releases?per_page=10`). Concatenate; truncate to
   ~12k chars. A full old..new range-walk is future work — intermediate-
   release notes may be missed on multi-minor jumps.
5. **Output** `{ "context": "..." }`. On missing hint / fetch failure, emit a
   "⚠️ Release notes NOT auto-fetched … default toward REVIEW" context and
   **exit 0**.

**Invariants:** always exit 0 (never fail the review); fetches the target
(new) tag's release notes, with a recent-releases list fallback — a full
old..new range-walk is future work, so intermediate-release notes may be
missed on multi-minor jumps; cap size to protect `max_diff_chars`.

### 2. `.ai/review-rules.md` (policy)

Instructs Serge: for a version-bump PR, use the injected release notes to
decide a verdict and always post the structured block. Verdict thresholds:

- **SAFE** — patch/minor, no config/API/env/volume/default changes in notes;
  diff is only the version tag.
- **REVIEW** (conservative default) — notes not fetched, OR possible-but-
  unclear config impact, OR low confidence.
- **UNSAFE** — removed/renamed config keys, changed defaults, dropped env
  vars, storage/PVC migrations, breaking API/CRD changes, or a major bump
  with a documented migration.

For REVIEW/UNSAFE, name the exact `overlays/librepod/` or `base/` file + key
to change. Migrations here = Kustomize/Helm-values/env edits, **not** app
source. `catalog.yaml` is generated — skip it. Non-bump PRs fall back to
normal manifest correctness/security review per `CLAUDE.md`.

Verdict block:
```
## 🤖 Bump review: <app> <old>→<new>
**Verdict:** ✅ SAFE | 🟡 REVIEW | 🔴 UNSAFE
**Why:** <one line>
**Breaking changes:** <bullets, or "none found">
**Migration needed:** <file + edit, or "none">
**Notes source:** <"fetched" | "not fetched — judged from diff">
```

Event stays `COMMENT`; rules reinforce "never approve/request-changes."

### 3. Resolution hints in all 26 `apps/*/metadata.yaml`

One line per app beside the existing `# renovate:` comment, e.g.:
```yaml
# renovate: datasource=docker depName=ghcr.io/immich-app/immich-server
# serge: notesRepo=immich-app/immich
version: "v3.1.0"
```
- `github-releases` apps → hint mirrors depName.
- `org/repo`-shaped docker depNames → often equal to the GitHub repo.
- registry-path docker (`quay.io/…`, `cr.smallstep.com/…`, bare `couchdb`)
  and helm → hint gives the real upstream repo; `notesUrl` where no GitHub
  releases exist.

### 4. `.github/workflows/ai-review.yaml` (small fixes)

- `fetch-depth: 0` on checkout so `git show <base>:` resolves the old
  version (currently shallow).
- Export `GITHUB_TOKEN=${{ github.token }}` (already in scope) as env for the
  context-script's API calls. No new secret.
- `mention_trigger`, `review_event`, author-association gate: unchanged.

## Testing

- **Local (no cluster, no Serge):** pipe a hand-built stdin JSON for a real
  open PR (e.g. #136 traefik, #129 immich) into `.ai/context-script`; assert
  correct version delta and fetched notes.
- **Live e2e:** `@askserge please review` on one open Renovate PR; eyeball the
  verdict. immich (#129) = adversarial (substantive notes); whoami = easy.
- Spot-check hint resolution across the three depName shapes.

## Out of scope (YAGNI)

Auto-trigger on `pull_request`; `REQUEST_CHANGES`/APPROVE; required-check
blocking; `.ai/review-tools.json` helper tools; any Renovate-config change.

## Risks

- **Hint drift:** a new app added without a `# serge:` hint degrades to
  "notes not fetched → REVIEW" (safe, visible). Mitigation later: a lint in
  `validate-apps.yaml`.
- **LLM misjudgment:** advisory-only means a wrong SAFE is caught by the human
  gate; a wrong UNSAFE costs only attention. Acceptable at this posture.
- **API rate limits / private release notes:** token-authenticated fetch;
  fail-soft covers the rest.
