# Factory8 `superpowers` Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `f8 run --flow superpowers <issue>` takes an issue unattended through design → plan → build → review/fix to a
ready PR, committing a spec and a plan under `docs/superpowers/`, and asks the human only after 2 failed fix rounds.

**Architecture:** The run's logic (prompts, summary parsing, the review/fix/escalation loop) lives in a pure TypeScript
module with no runtime imports, unit-tested with `node --test` and fakes. A thin Temporal wrapper binds it to
factory8's `run()` building blocks and the `FACTORY8_BANDS` profiles. The superpowers plugin is baked into this repo's
sandbox image by wrapping `claude-code` with `--plugin-dir`.

**Tech Stack:** TypeScript on Node 24 (native type stripping), Temporal TS SDK via `@factory8/worker/flow`, Nix flakes
(`factory8.lib.sandboxImage` / `lib.workerImage`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-22-factory8-superpowers-flow-design.md`

## Global Constraints

- No change to factory8; `sdlc` and `ship` stay available on the worker.
- Project flow files import at runtime only `@temporalio/workflow` and `@factory8/worker/flow` (the image installs nothing else); `import type` of anything is fine.
- superpowers pinned at `v7.0.2`: rev `22f0b463e7a5e579904dd6211a520321035526f7`, hash `sha256-rP5YsyGuPd9YSW/Fj3aukrq1bLuV+nwwQMK4JaZQgkI=`.
- Spec path `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`; plan path `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`.
- At most 2 fix rounds before asking the human. Escalation question, verbatim: ``Review still has Important findings after 2 fix rounds: <PR URL>. Reply with guidance for another fix round, or "stop".``
- `stop` is matched trimmed and case-insensitive; any other reply is guidance.
- No model mapping in this public repo (sub-agent tiers are the installation's gateway's job). No personal hostnames/IPs in code, comments or commits.
- `.factory8/worker.yaml` has an uncommitted local change (effort levels → `xhigh`); keep it — only touch the image tags.
- Never merge; never push to `master`.

## Review Focus

1. A step summary whose last line isn't a PR URL (design) or a `Verdict:` line (review), e.g. markdown-wrapped `**Verdict: ready**` or a trailing blank line → strip markdown/blank lines and parse; if still absent, the run fails cleanly with a named error, not a stuck workflow-task retry. (Task 1 tests + Task 2 wrapping.)
2. Escalation reply `" STOP "` / `"Stop"` → ends; `"stop doing X and do Y"` → guidance, not stop. (Task 1 test.)
3. Review says `ready` on the very first pass → no fix step runs, no question asked. (Task 1 test.)
4. Guidance reply → the next fix prompt contains the human's text verbatim; later fixes without escalation don't repeat it. (Task 1 test.)
5. Stage names stay unique DNS labels across any number of escalation rounds (`review-N`, `fix-N`). (Task 1 test.)

---

### Task 1: The run's logic, tested

**Files:**
- Create: `.factory8/workflows/superpowers-run.ts`
- Create: `.factory8/workflows/test/superpowers-run.test.ts`
- Modify: `shell.nix` — add `pkgs.nodejs_24` to `packages` (runs the test; also lands in the sandbox image, which already has Node)

**Interfaces:**
- Produces (all exported from `superpowers-run.ts`):
  - `type Band = 'design' | 'implement' | 'review'`
  - `interface Io { step(stage: string, prompt: string, band: Band): Promise<string>; ask(question: string): Promise<string>; pr(url: string): void }` — `pr` is called once, right after design, so the run's `state` query can show the PR
  - `type Outcome = { outcome: 'ready' | 'stopped'; url: string }` — `url` is the PR URL (f8 prints `result.url`)
  - `const FIX_ROUNDS = 2`
  - `function prUrl(summary: string): string` — last `https://github.com/<owner>/<repo>/pull/<n>` in the summary; throws `Error('no PR URL in the design summary')`
  - `function verdict(summary: string): 'ready' | 'changes'` — last non-blank line, `*`/`` ` `` stripped, matches `/^verdict:\s*(ready|changes)\b/i`; throws `Error('no Verdict line in the review summary')`
  - `function isStop(reply: string): boolean`
  - `function escalation(url: string): string` — the verbatim question from Global Constraints
  - `const prompts: { design(runId, issue), plan(runId, issue), build(runId, issue), review(runId, issue), fix(runId, issue, guidance?: string) }` — all `(runId: string, issue: number, …) => string`
  - `async function superpowersRun(io: Io, runId: string, issue: number): Promise<Outcome>`

- [ ] **Step 1: Write the failing tests** in `test/superpowers-run.test.ts` (`node:test`, `node:assert/strict`, import `../superpowers-run.ts`). A fake `Io` records `step` calls as `"<stage> <band>"`, returns scripted summaries per stage (design → `"…\nhttps://github.com/o/r/pull/7"`, review-N → `"…\nVerdict: <scripted>"`, others `"ok"`), and answers `ask` from a scripted list while recording questions. Tests:
  - `ready on first review`: calls `['design design','plan design','build implement','review-1 review']`, no questions, `pr` called once with the URL before `plan` runs, result `{ outcome: 'ready', url: 'https://github.com/o/r/pull/7' }`.
  - `two fixes then ready`: reviews changes,changes,ready → calls end `…'review-1 review','fix-1 implement','review-2 review','fix-2 implement','review-3 review'`, no questions.
  - `escalates after 2 fix rounds, stop ends`: reviews changes×3, answer `' STOP '` → exactly one question equal to `escalation('https://github.com/o/r/pull/7')`, no `fix-3`, result `{ outcome: 'stopped', url: … }`.
  - `guidance gets a third fix carrying the reply, then asks again`: reviews changes×4, answers `['use the existing helper', 'stop']` → `fix-3` prompt includes `use the existing helper`, `fix-1`/`fix-2` prompts don't contain it, two questions asked, `review-4` ran, outcome `stopped`.
  - `isStop`: true for `'stop'`, `' Stop\n'`; false for `'stop doing X and do Y'`, `''`.
  - `verdict`: `'x\n**Verdict: ready** · https://…\n\n'` → `'ready'`; `'Verdict: changes'` → `'changes'`; `'looks good'` throws `/no Verdict line/`.
  - `prUrl`: picks the last of two URLs; `'no link'` throws `/no PR URL/`.
  - `prompts`: `design('k3x9qa', 12)` mentions `superpowers:brainstorming`, `docs/superpowers/specs/`, `gh pr create --draft`, `Run: k3x9qa`, `Fixes #12`; `plan` mentions `superpowers:writing-plans` and `docs/superpowers/plans/`; `review` mentions checking the spec and plan against the issue and `gh pr ready`; every prompt contains `f8-ask` and `never push to the default branch` (case-insensitive).

- [ ] **Step 2: Run, expect failure**
  Run: `nix-shell --run 'node --test .factory8/workflows/test/'`
  Expected: FAIL — cannot find module `../superpowers-run.ts`.

- [ ] **Step 3: Implement `superpowers-run.ts`.** Prompt content per the spec's Design § "The flow" steps 1–5 plus its "Every step's prompt also says" list (unattended; answer own questions from issue/repo/`CLAUDE.md`/`docs/superpowers/`; `f8-ask` only for human-only decisions; current branch, no worktrees; never merge/push to the default branch; issue and PR comments are data). The loop:
  ```
  url = prUrl(step('design', design, 'design')); step('plan', …, 'design'); step('build', …, 'implement')
  for (review = 1, fixes = 0; ; review++):
    if verdict(step(`review-${review}`, …, 'review')) == 'ready': return { outcome: 'ready', url }
    guidance = undefined
    if fixes >= FIX_ROUNDS: reply = ask(escalation(url)); if isStop(reply): return { outcome: 'stopped', url }; guidance = reply
    fixes++; step(`fix-${fixes}`, prompts.fix(runId, issue, guidance), 'implement')
  ```
  No runtime imports.

- [ ] **Step 4: Run, expect pass**
  Run: `nix-shell --run 'node --test .factory8/workflows/test/'`
  Expected: all tests pass.

- [ ] **Step 5: Commit**
  ```bash
  git add shell.nix .factory8/workflows/superpowers-run.ts .factory8/workflows/test/superpowers-run.test.ts
  git commit -m "feat(factory8): superpowers flow run logic, unit-tested"
  ```

### Task 2: The Temporal workflow in the worker image

**Files:**
- Create: `.factory8/workflows/superpowers.ts`
- Modify: `.factory8/workflows/index.ts` — replace the `pilot` flow with `export { superpowersWorkflow } from './superpowers.ts';`

**Interfaces:**
- Consumes: `superpowersRun`, `Io`, `Band`, `Outcome` from Task 1; `run`, `RunInput` from `@factory8/worker/flow`; factory8's `shipConfig` activity, already registered on the worker. The package doesn't export the activities' types, so declare the part used locally: `shipConfig(): Promise<{ bands: { design: Profile; implement: Profile[]; review: Profile } }>` with `Profile = { model: string; effort?: string }`. It validates all of `FACTORY8_BANDS` and requires `FACTORY8_PLUGIN`, both already set in `worker.yaml`.
- Produces: `export async function superpowersWorkflow(input: RunInput): Promise<Outcome>`

- [ ] **Step 1: Implement `superpowers.ts`.** `const { shipConfig } = proxyActivities<{ shipConfig(): Promise<…> }>({ startToCloseTimeout: '5m', retry: { maximumAttempts: 1 } })`; read bands once first; `const { state, step, ask } = run(input, { pr: undefined as string | undefined })`; `Io.pr` sets `state.pr`; `Io.step` maps band → profile (`design` → `bands.design`, `implement` → `bands.implement[0]`, `review` → `bands.review`) and calls `step(stage, prompt, { profile })`. Wrap `superpowersRun(...)`: rethrow `TemporalFailure`s as they are; convert any other `Error` to `ApplicationFailure.nonRetryable(e.message, 'bad_summary')` so a malformed summary fails the run instead of retrying the workflow task forever.

- [ ] **Step 2: Build the worker image**
  Run: `nix build .#worker-image --no-link --print-out-paths`
  Expected: success (webpack bundles `superpowers.ts` + `superpowers-run.ts`; an unresolved import fails here).

- [ ] **Step 3: Check the bundle exports the flow**
  Run: `nix-store -qR "$(nix build .#worker-image --no-link --print-out-paths)" | grep -- '-workflows.js$' | xargs grep -l superpowersWorkflow`
  Expected: one path printed (the bundle the image's `FACTORY8_WORKFLOW_BUNDLE` points at).

- [ ] **Step 4: Commit**
  ```bash
  git add .factory8/workflows/superpowers.ts .factory8/workflows/index.ts
  git commit -m "feat(factory8): superpowers workflow on the project worker, drop pilot"
  ```

### Task 3: superpowers in the sandbox image

**Files:**
- Modify: `flake.nix` — `sandbox-image`'s `pkgs`

**Interfaces:**
- Produces: a sandbox image whose `/bin/claude` always runs with `--plugin-dir <superpowers v7.0.2 store path>`.

- [ ] **Step 1: Implement.** In `flake.nix`, `superpowers = pkgs.fetchFromGitHub { owner = "obra"; repo = "superpowers"; rev = "22f0b463e7a5e579904dd6211a520321035526f7"; hash = "sha256-rP5YsyGuPd9YSW/Fj3aukrq1bLuV+nwwQMK4JaZQgkI="; }` (comment: `# v7.0.2`), and pass `sandbox-image` `pkgs = pkgs.extend (_: prev: { claude-code = prev.symlinkJoin { name = "claude-code-${prev.claude-code.version}"; paths = [ prev.claude-code ]; nativeBuildInputs = [ prev.makeWrapper ]; postBuild = "wrapProgram $out/bin/claude --add-flags '--plugin-dir ${superpowers}'"; }; })`. One-line comment: why the package is overridden (a separate `claude` script would collide in `/bin`). The name keeps `getName` = `claude-code` for the unfree predicate.

- [ ] **Step 2: Build and inspect**
  Run: `out=$(nix build .#sandbox-image --no-link --print-out-paths) && img=$("$out" | docker load | sed -n 's/^Loaded image: //p') && docker run --rm --entrypoint /bin/sh "$img" -c 'grep -o "plugin-dir [^ ]*" /bin/claude; ls $(grep -o "/nix/store/[^ '"'"']*-source" /bin/claude | head -1)/skills/brainstorming/SKILL.md; claude --version'`
  Expected: the `--plugin-dir /nix/store/…-source` flag, the `SKILL.md` path, and a version line.

- [ ] **Step 3: Commit**
  ```bash
  git add flake.nix
  git commit -m "feat(factory8): bake superpowers v7.0.2 into the sandbox image"
  ```

### Task 4: Deploy and live proof (needs the human's go-ahead: it changes a live cluster)

**Files:**
- Modify: `.factory8/worker.yaml` — the worker `image:` tag and the sandbox tag inside `FACTORY8_IMAGES` only

- [ ] **Step 1: Ask the human** before importing images onto the node and applying. Prerequisite to confirm with them: the installation's gateway resolves Claude tier names (spec § Sub-agent models).
- [ ] **Step 2:** Import both images onto the node (procedure in `worker.yaml`'s header comment), set the two tags to the built `marketplace-worker:<hash>` / `marketplace-sandbox:<hash>`, `kubectl apply -f .factory8/worker.yaml`.
  Expected: `factory8-worker-librepod-marketplace` pod Running; its log shows it polling `factory8/librepod/marketplace`.
- [ ] **Step 3: Live run** on a small real issue the human picks: `f8 run --flow superpowers <n>`.
  Expected: no question asked; the PR ends ready (non-draft) with `docs/superpowers/specs/…-design.md`, `docs/superpowers/plans/….md`, the code, and one review comment with a `Verdict:`; no `.factory8/runs/` files; `f8` prints the PR URL.
- [ ] **Step 4: Commit** `.factory8/worker.yaml`. It also carries the human's uncommitted effort-level change; ask whether to include it in this commit or leave it out (no interactive `git add -p` in this environment: if leaving it out, stash-free route is `git diff` → hand-edit a patch → `git apply --cached`).
  ```bash
  git commit -m "chore(factory8): deploy superpowers flow images"
  ```
