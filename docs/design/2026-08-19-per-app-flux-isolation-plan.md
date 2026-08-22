# Per-App Flux Isolation + Generic Git Write Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every installed app fail in isolation, and replace the Gogs REST write path with a generic git client so the app-store repo can be pointed at any git provider.

**Architecture:** Three Flux layers with distinct meanings (`user-apps-source` = the git source is seeded; `user-apps` = declarations applied, `wait: false`; `marketplace-<app>` = that app is healthy). The shared root `kustomization.yaml` is deleted in favour of Flux's auto-generated one, so install/uninstall touch only their own app directory. Server-side, `GogsService` is replaced by three focused units: `GitClient` (mechanical git), `GitRemoteService` (where + how to authenticate), `UserAppsRepoService` (app-level semantics + one-time layout migration).

**Tech Stack:** NestJS 11 (CommonJS, SWC), vitest, `@kubernetes/client-node`, `js-yaml`, the `git` CLI, FluxCD v2.9.3, Kustomize, Playwright (Tier 1 hermetic / Tier 2 k3d).

**Design doc:** `docs/design/2026-08-19-per-app-flux-isolation-design.md` — read it first; the "Key facts discovered during design" table records what was verified and how.

## Global Constraints

- **Never regenerate `catalog.yaml` locally.** Both copies (`catalog.yaml`, `apps/marketplace-ui/base/catalog.yaml`) are CI-generated from `apps/*/metadata.yaml`. Running `scripts/generate-catalog.sh` produces a large misleading diff.
- **Do not change any app's `metadata.yaml` `templates:` block.** Flux honors the nested `apps/<app>/kustomization.yaml` (design F4), so no template changes are needed.
- **Version bump goes in four places or the release is a no-op:** `apps/marketplace-ui/metadata.yaml` `spec.version`, `apps/marketplace-ui/overlays/librepod/kustomization.yaml` `newTag`, `infrastructure/system-apps/marketplace-ui.yaml` `ref.tag`, and `ui/package.json` `version`. Target version: **`0.6.0`** (from `0.5.3`).
- **Commit/PR hygiene:** never name concrete device or cluster hostnames in commit messages, PR text, or public docs. Use `dev`/`prod`/`staging`.
- **All `npm` commands run from `ui/`** (the workspace root), not from `ui/packages/server`.
- **One transport: `http(s)`. Do not write SSH code.** The installer's `ssh://` branch is deferred (design §3, Non-Goals). If you find yourself reaching for `GIT_SSH_COMMAND`, `ssh-keyscan`, `known_hosts` or a 0600 identity copy, stop — the correct behaviour for an `ssh://` URL in this release is a *loud rejection*, implemented in Task 2. Reason: Tier 1 has no port 22 (design F11), so SSH would ship as the only transport no hermetic test covers, and its original "no baked-in credential" rationale no longer holds (F12).
- **Never put git credentials in a remote URL** — they leak into `git remote -v`, the reflog, and error messages. Use a `0600` credentials file via `credential.helper`.
- **Use the discovered URL verbatim** — no rewriting, no scheme translation, no host normalisation. The point of discovery is that the installer and Flux cannot diverge. The **trailing-dot FQDN belongs in the manifest**, not in code: `infrastructure/user-apps-source/gitrepository.yaml` carries `gogs.gogs.svc.cluster.local.` (Task 8), so both sides read the same absolute name. Do not "helpfully" add or strip that dot in `GitRemoteService`. (Design F13 records an unresolved contradiction here: `configmap.yaml`'s `GOGS_URL` comment says the dot is production-load-bearing, while the dev cluster — whose pod search lists carry no app zone — cannot reproduce the failure either way. The absolute form is the option that is correct under both readings, which is why it goes in the manifest. Verify on a device per Task 8 Step 5.)
- **Never mount a Secret the pod's startup depends on without a placeholder.** Reflector-populated Secrets can be briefly absent — `cold-boot-repro.sh` deletes this one in all three namespaces. A plain `secret:` volume then fails to mount and the container never starts, so `/api/health` never answers and an open gate looks held. Declare an empty `secretGenerator` and let Reflector fill it (Task 7), exactly as `gogs-auth` does today.
- **Nothing may throw out of `onModuleInit` when git is unreachable.** That is the #176 failure mode: a one-shot bootstrap that fails leaves the container broken for its whole lifetime. Log and self-heal lazily on the next call.

---

## File Structure

**New (server):**
| File | Responsibility |
|---|---|
| `ui/packages/server/src/installed/git-client.ts` | Mechanical git operations in a working directory. No knowledge of apps or Kubernetes. |
| `ui/packages/server/src/installed/git-remote.service.ts` | Resolves *where* the repo is and *how* to authenticate: env override → `GitRepository/user-apps-source`; credential materialisation for `http(s)`, loud rejection for `ssh://`. No knowledge of apps or git commands. |
| `ui/packages/server/src/installed/user-apps-repo.service.ts` | App-level semantics: list/write/remove `apps/<name>/`, and the one-time layout migration. Uses the two above. |

**Deleted (server):** `gogs.service.ts`, `gogs.service.spec.ts`.

**Modified (server):** `installed.service.ts`, `installed.service.spec.ts`, `installed.module.ts`, `rbac-manifest.spec.ts`.

**Modified (manifests):** `apps/marketplace-ui/base/{serviceaccount,deployment,configmap,kustomization}.yaml`, `apps/marketplace-ui/overlays/librepod/kustomization.yaml`, `apps/marketplace-ui/metadata.yaml`, `infrastructure/user-apps-source/gitrepository.yaml`, `infrastructure/user-apps-source/user-apps.yaml`, `infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`, `infrastructure/system-apps/marketplace-ui.yaml`, `clusters/{librepod,librepod-dev,librepod-k3d}/user-apps-source.yaml`, `ui/Dockerfile`, `ui/package.json`.

**Modified (tests):** `ui/packages/e2e/projects/tier1.config.ts`, `ui/packages/e2e/support/gogs/seed.sh`, `ui/packages/e2e/support/cold-boot-repro.sh`, `ui/packages/e2e/support/run-tier2.sh`, plus new specs under `ui/packages/e2e/tests/`.

**Modified (docs):** `ui/CLAUDE.md`, `docs/user-guide.md`, `docs/DECISIONS_LOG.md`, `.claude/skills/verify-app/SKILL.md`, `.claude/skills/verify-app/references/troubleshooting.md`.

---

### Task 1: `GitClient` — mechanical git operations

**Files:**
- Create: `ui/packages/server/src/installed/git-client.ts`
- Test: `ui/packages/server/src/installed/git-client.spec.ts`

**Interfaces:**
- Consumes: nothing (leaf unit).
- Produces:
  ```ts
  export interface GitAuth { env: NodeJS.ProcessEnv; configArgs: string[] }
  export class GitClient {
    run(cwd: string, args: string[], auth?: GitAuth): Promise<{ stdout: string; stderr: string }>
    clone(url: string, dir: string, branch: string, auth: GitAuth): Promise<void>
    fetchAndReset(dir: string, branch: string, auth: GitAuth): Promise<void>
    stageAll(dir: string): Promise<void>
    removePath(dir: string, relPath: string): Promise<void>
    commit(dir: string, message: string): Promise<boolean>   // false = nothing staged
    push(dir: string, branch: string, auth: GitAuth): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `ui/packages/server/src/installed/git-client.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitClient } from './git-client';

const NO_AUTH = { env: {}, configArgs: [] };

/**
 * Address the fixture origin as a URL, never as a bare path.
 *
 * `git clone --depth 1 /some/path` SILENTLY IGNORES --depth ("--depth is ignored
 * in local clones"), so a bare path would make every test here exercise a full
 * clone and leave the two shallow behaviours production depends on completely
 * uncovered: `fetch --depth 1` advancing refs/remotes/origin/<branch>, and
 * pushing from a shallow clone. `file://` forces the real transport.
 */
const fileUrl = (path: string): string => `file://${path}`;

/** A bare repo with one commit on `master`, to act as the "remote". Returns its PATH. */
async function makeOriginWithSeed(root: string): Promise<string> {
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const git = new GitClient();
  await git.run(root, ['init', '--bare', '--initial-branch=master', origin]);
  await mkdir(seed, { recursive: true });
  await git.run(seed, ['init', '--initial-branch=master']);
  await writeFile(join(seed, 'README.md'), '# user apps\n');
  await git.stageAll(seed);
  await git.commit(seed, 'Initial commit');
  await git.run(seed, ['push', origin, 'master']);
  return origin;
}

describe('GitClient', () => {
  let root: string;
  let git: GitClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-client-spec-'));
    git = new GitClient();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clones a branch, then round-trips a commit back to the origin', async () => {
    const origin = await makeOriginWithSeed(root);
    const work = join(root, 'work');

    await git.clone(fileUrl(origin), work, 'master', NO_AUTH);
    expect(await readFile(join(work, 'README.md'), 'utf8')).toContain('user apps');

    await mkdir(join(work, 'apps', 'demo'), { recursive: true });
    await writeFile(join(work, 'apps', 'demo', 'release.yaml'), 'kind: Kustomization\n');
    await git.stageAll(work);
    expect(await git.commit(work, 'install demo')).toBe(true);
    await git.push(work, 'master', NO_AUTH);

    // A second, independent clone must observe the pushed commit.
    const verify = join(root, 'verify');
    await git.clone(fileUrl(origin), verify, 'master', NO_AUTH);
    expect(await readFile(join(verify, 'apps/demo/release.yaml'), 'utf8')).toContain('Kustomization');
  });

  it('commit() returns false when the tree is clean, so callers can stay idempotent', async () => {
    const origin = await makeOriginWithSeed(root);
    const work = join(root, 'work');
    await git.clone(fileUrl(origin), work, 'master', NO_AUTH);

    await git.stageAll(work);
    expect(await git.commit(work, 'no-op')).toBe(false);
  });

  it('removePath deletes a directory from the index and the worktree', async () => {
    const origin = await makeOriginWithSeed(root);
    const work = join(root, 'work');
    await git.clone(fileUrl(origin), work, 'master', NO_AUTH);
    await mkdir(join(work, 'apps', 'gone'), { recursive: true });
    await writeFile(join(work, 'apps', 'gone', 'release.yaml'), 'kind: Kustomization\n');
    await git.stageAll(work);
    await git.commit(work, 'add gone');

    await git.removePath(work, 'apps/gone');
    expect(await git.commit(work, 'uninstall gone')).toBe(true);
    const { stdout } = await git.run(work, ['ls-files', 'apps/gone']);
    expect(stdout.trim()).toBe('');
  });

  it('fetchAndReset discards local mess and matches the origin exactly', async () => {
    const origin = await makeOriginWithSeed(root);
    const work = join(root, 'work');
    await git.clone(fileUrl(origin), work, 'master', NO_AUTH);

    await writeFile(join(work, 'README.md'), 'locally corrupted\n');
    await writeFile(join(work, 'stray.yaml'), 'kind: Stray\n');
    await git.fetchAndReset(work, 'master', NO_AUTH);

    expect(await readFile(join(work, 'README.md'), 'utf8')).toContain('user apps');
    const { stdout } = await git.run(work, ['status', '--porcelain']);
    expect(stdout.trim()).toBe(''); // untracked stray removed too
  });

  it('fetchAndReset OBSERVES a new upstream commit', async () => {
    // The discard test above passes even if `fetch` never advances
    // refs/remotes/origin/<branch> — `reset --hard` would just re-pin the same
    // commit. That bug's production symptom is reads that are stale forever, so
    // it needs its own test: a second writer pushes, and our working copy must
    // see it.
    const origin = await makeOriginWithSeed(root);
    const work = join(root, 'work');
    await git.clone(fileUrl(origin), work, 'master', NO_AUTH);

    const other = join(root, 'other');
    await git.clone(fileUrl(origin), other, 'master', NO_AUTH);
    await mkdir(join(other, 'apps', 'late'), { recursive: true });
    await writeFile(join(other, 'apps/late/release.yaml'), 'kind: Kustomization\n');
    await git.stageAll(other);
    await git.commit(other, 'landed after our clone');
    await git.push(other, 'master', NO_AUTH);

    await git.fetchAndReset(work, 'master', NO_AUTH);

    expect(await readFile(join(work, 'apps/late/release.yaml'), 'utf8')).toContain('Kustomization');
  });

  it('surfaces git failures as errors carrying stderr', async () => {
    await expect(
      git.clone(fileUrl(join(root, 'does-not-exist.git')), join(root, 'work'), 'master', NO_AUTH),
    ).rejects.toThrow(/does-not-exist/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/git-client.spec.ts`
Expected: FAIL — `Failed to resolve import "./git-client"`.

- [ ] **Step 3: Write the implementation**

Create `ui/packages/server/src/installed/git-client.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Env + `-c` flags that teach a git invocation how to authenticate. */
export interface GitAuth {
  env: NodeJS.ProcessEnv;
  configArgs: string[];
}

/**
 * Thin wrapper over the `git` binary. Deliberately knows nothing about apps,
 * Kubernetes, or the marketplace: it is the only place that spawns git, so the
 * safety rules (execFile not exec, no prompting, no creds in argv) live here.
 */
@Injectable()
export class GitClient {
  private readonly logger = new Logger(GitClient.name);

  // Committer identity is passed per-invocation via `-c` so the container needs
  // no global git config and no writable $HOME.
  private static readonly IDENTITY = [
    '-c', 'user.name=librepod-marketplace',
    '-c', 'user.email=marketplace@librepod.local',
  ];

  async run(
    cwd: string,
    args: string[],
    auth?: GitAuth,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync('git', [...(auth?.configArgs ?? []), ...args], {
        cwd,
        env: {
          ...process.env,
          // Never block a request thread waiting on an interactive prompt.
          GIT_TERMINAL_PROMPT: '0',
          // Hermetic: no system/global git config may influence a repo mutation.
          // Notably it stops an inherited credential.helper from shadowing the
          // per-invocation one, and keeps unit tests independent of the dev box.
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          ...(auth?.env ?? {}),
        },
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error: unknown) {
      const e = error as { stderr?: string; message?: string };
      const detail = (e.stderr || e.message || 'unknown git failure').trim();
      throw new Error(`git ${args.join(' ')} failed: ${detail}`);
    }
  }

  async clone(url: string, dir: string, branch: string, auth: GitAuth): Promise<void> {
    // `--depth 1` keeps the clone tiny; this repo's history is not interesting
    // to the installer, only its current tree.
    // Run from the target's parent, not process.cwd(): the caller has just
    // ensured that directory exists, whereas cwd is incidental.
    await this.run(dirname(dir), [
      'clone', '--depth', '1', '--branch', branch, '--single-branch', url, dir,
    ], auth);
  }

  async fetchAndReset(dir: string, branch: string, auth: GitAuth): Promise<void> {
    await this.run(dir, ['fetch', '--depth', '1', 'origin', branch], auth);
    await this.run(dir, ['reset', '--hard', `origin/${branch}`]);
    // -x removes ignored files too: a half-written app dir must never survive
    // into the next operation and become part of Flux's auto-generated build.
    await this.run(dir, ['clean', '-fdx']);
  }

  async stageAll(dir: string): Promise<void> {
    await this.run(dir, ['add', '-A']);
  }

  async removePath(dir: string, relPath: string): Promise<void> {
    await this.run(dir, ['rm', '-r', '--quiet', '--ignore-unmatch', relPath]);
  }

  /** Returns false when there is nothing staged, so callers stay idempotent. */
  async commit(dir: string, message: string): Promise<boolean> {
    const { stdout } = await this.run(dir, ['status', '--porcelain']);
    if (stdout.trim() === '') return false;
    await this.run(dir, [...GitClient.IDENTITY, 'commit', '-m', message]);
    return true;
  }

  async push(dir: string, branch: string, auth: GitAuth): Promise<void> {
    await this.run(dir, ['push', 'origin', `HEAD:${branch}`], auth);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/git-client.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/git-client.ts ui/packages/server/src/installed/git-client.spec.ts
git commit -m "feat(marketplace-ui): add GitClient, a thin wrapper over the git binary (#182)"
```

---

### Task 2: `GitRemoteService` — remote discovery + credentials

**Files:**
- Create: `ui/packages/server/src/installed/git-remote.service.ts`
- Test: `ui/packages/server/src/installed/git-remote.service.spec.ts`

**Interfaces:**
- Consumes: `GitAuth` from Task 1; `CustomObjectsApi` (injected, as `FluxStatusService` already does).
- Produces:
  ```ts
  export interface GitRemote { url: string; branch: string; auth: GitAuth }
  export class GitRemoteService {
    constructor(config: ConfigService, customObjectsApi: CustomObjectsApi)
    resolve(): Promise<GitRemote>   // cached after first success
  }
  ```

Behaviour to implement:
- URL/branch from `USER_APPS_GIT_URL` / `USER_APPS_GIT_BRANCH` (default branch `master`) when set; otherwise `GET gitrepositories/user-apps-source` in `flux-system` → `spec.url`, `spec.ref.branch ?? 'master'`.
- Credential directory from `USER_APPS_GIT_CREDENTIALS_DIR` (default `/etc/user-apps-git`).
- `http(s)://` → `USER_APPS_GIT_USERNAME`/`USER_APPS_GIT_PASSWORD`, else files `username`/`password` in that directory; written to a `0600` `.git-credentials` consumed via `credential.helper=store`.
- **`ssh://` → reject with a named error.** This release ships one transport (see Global Constraints). The message must say *what* to do — repoint the GitRepository at `http(s)`, or track the SSH follow-up — because the alternative is a stack of confusing git auth failures.
- The URL is used **verbatim**: the trailing-dot FQDN lives in `gitrepository.yaml` (Task 8), never in this service.

**Why the k8s client is injected rather than constructed inline:** it matches
`flux-status.service.ts`, and it means the discovery test can hand in a fake
instead of reaching into the instance with `vi.spyOn(svc as never, 'readGitRepository')`.
Spying on a private method to make a unit testable is a smell that outlives the
test — a later refactor renames the method and the test silently stops asserting
anything.

- [ ] **Step 1: Write the failing test**

Create `ui/packages/server/src/installed/git-remote.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import type { CustomObjectsApi } from '@kubernetes/client-node';
import { GitRemoteService } from './git-remote.service';

function configOf(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

/**
 * A CustomObjectsApi double. Injected rather than spied on: reaching into the
 * instance with `vi.spyOn(svc as never, 'readGitRepository')` binds the test to a
 * private name, and a later rename makes it silently assert nothing.
 */
function fakeApi(spec?: Record<string, unknown>) {
  const getNamespacedCustomObject = vi.fn(async () => ({ spec }));
  return {
    api: { getNamespacedCustomObject } as unknown as CustomObjectsApi,
    getNamespacedCustomObject,
  };
}

describe('GitRemoteService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-remote-spec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prefers the env override and never touches Kubernetes (the Tier 1 seam)', async () => {
    const k8s = fakeApi();
    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'http://127.0.0.1:43000/flux/user-apps.git',
      USER_APPS_GIT_BRANCH: 'master',
      USER_APPS_GIT_USERNAME: 'flux',
      USER_APPS_GIT_PASSWORD: 'pass@w0rd',
      USER_APPS_GIT_CREDENTIALS_DIR: join(root, 'creds'),
      USER_APPS_WORK_DIR: join(root, 'work'),
    }), k8s.api);

    const remote = await svc.resolve();

    expect(k8s.getNamespacedCustomObject).not.toHaveBeenCalled();
    expect(remote.url).toBe('http://127.0.0.1:43000/flux/user-apps.git');
    expect(remote.branch).toBe('master');
    // credential.helper points at a file we own, and the password is NOT in argv
    const helper = remote.auth.configArgs.join(' ');
    expect(helper).toContain('credential.helper=store --file=');
    expect(helper).not.toContain('pass@w0rd');
  });

  it('writes .git-credentials 0600 — it holds a plaintext password', async () => {
    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'https://git.example.com/flux/user-apps.git',
      USER_APPS_GIT_USERNAME: 'flux',
      USER_APPS_GIT_PASSWORD: 'p@ss/word',
      USER_APPS_GIT_CREDENTIALS_DIR: join(root, 'creds'),
      USER_APPS_WORK_DIR: join(root, 'work'),
    }), fakeApi().api);

    const remote = await svc.resolve();
    const file = /--file=(\S+)/.exec(remote.auth.configArgs.join(' '))![1];

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // URL-encoded so a password containing / or @ cannot corrupt the entry.
    expect(await readFile(file, 'utf8')).toContain('https://flux:p%40ss%2Fword@git.example.com');
  });

  it('keeps an explicit default port in the credential entry', async () => {
    // REGRESSION GUARD. `new URL('http://h:80/x').host` is 'h' — the WHATWG parser
    // strips a default port — but git looks the credential up under 'h:80'. Build
    // the entry from URL.host and the entry never matches: git falls back to
    // prompting, GIT_TERMINAL_PROMPT=0 turns that into an auth failure, and the
    // ONLY affected URLs are the ones with an explicit :80/:443 — i.e. production.
    // Tier 1 uses :43000 (non-default) and would stay green.
    const creds = join(root, 'creds');
    await mkdir(creds, { recursive: true });
    await writeFile(join(creds, 'username'), 'flux\n');   // trailing newline on purpose
    await writeFile(join(creds, 'password'), 'from-file\n');

    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'http://gogs.gogs.svc.cluster.local.:80/flux/user-apps.git',
      USER_APPS_GIT_CREDENTIALS_DIR: creds,
      USER_APPS_WORK_DIR: join(root, 'work'),
    }), fakeApi().api);

    const remote = await svc.resolve();
    const file = /--file=(\S+)/.exec(remote.auth.configArgs.join(' '))![1];

    // Also proves the mounted-file path (production shape: the Secret's `username`
    // and `password` keys arrive as files) and that the trailing newline is trimmed
    // — an embedded newline silently breaks the match the same way.
    expect(await readFile(file, 'utf8')).toBe(
      'http://flux:from-file@gogs.gogs.svc.cluster.local.:80\n',
    );
  });

  it('fails with an actionable message when the credential is missing', async () => {
    // The mounted Secret is Reflector-populated and starts EMPTY, so this is a real
    // startup state, not a hypothetical. It must be a clear error and it must NOT be
    // cached — the next call has to succeed once Reflector fills it.
    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'http://gogs/flux/user-apps.git',
      USER_APPS_GIT_CREDENTIALS_DIR: join(root, 'empty'),
      USER_APPS_WORK_DIR: join(root, 'work'),
    }), fakeApi().api);

    await expect(svc.resolve()).rejects.toThrow(/no username\/password/);
    await expect(svc.resolve()).rejects.toThrow(/no username\/password/); // not cached
  });

  it('rejects an ssh:// remote with a message that says what to do', async () => {
    // This release ships ONE transport (design §3). An ssh:// URL is an operator
    // misconfiguration, and it has to name the fix rather than surfacing as a pile
    // of git auth errors.
    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'ssh://git@gogs.gogs.svc.cluster.local:22/flux/user-apps.git',
      USER_APPS_GIT_CREDENTIALS_DIR: join(root, 'creds'),
      USER_APPS_WORK_DIR: join(root, 'work'),
    }), fakeApi().api);

    await expect(svc.resolve()).rejects.toThrow(/ssh.*not supported/i);
  });

  it('discovers url and branch from GitRepository/user-apps-source when no override is set', async () => {
    const creds = join(root, 'creds');
    await mkdir(creds, { recursive: true });
    await writeFile(join(creds, 'username'), 'flux');
    await writeFile(join(creds, 'password'), 'secret');

    const k8s = fakeApi({
      url: 'https://git.example.com/flux/user-apps.git',
      ref: { branch: 'main' },
    });
    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_CREDENTIALS_DIR: creds,
      USER_APPS_WORK_DIR: join(root, 'work'),
    }), k8s.api);

    const remote = await svc.resolve();

    // Verbatim — no host normalisation, no scheme translation.
    expect(remote.url).toBe('https://git.example.com/flux/user-apps.git');
    expect(remote.branch).toBe('main');
    expect(k8s.getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'source.toolkit.fluxcd.io',
        plural: 'gitrepositories',
        name: 'user-apps-source',
        namespace: 'flux-system',
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/git-remote.service.spec.ts`
Expected: FAIL — cannot resolve `./git-remote.service`.

- [ ] **Step 3: Write the implementation**

Create `ui/packages/server/src/installed/git-remote.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomObjectsApi } from '@kubernetes/client-node';
import { mkdir, writeFile, readFile, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitAuth } from './git-client';

export interface GitRemote {
  url: string;
  branch: string;
  auth: GitAuth;
}

interface GitRepositoryObject {
  spec?: { url?: string; ref?: { branch?: string } };
}

/**
 * Answers "which git repo, on which branch, with which credentials?".
 *
 * The URL is discovered from GitRepository/user-apps-source — the same object
 * Flux reads — so the installer can never commit to a repo Flux is not
 * reconciling. Repointing that object at GitHub/GitLab needs no code change (it
 * does need a pod restart: the resolved remote is cached for the process
 * lifetime). We deliberately do NOT read the GitRepository's secretRef: its name
 * is dynamic, so RBAC could not scope it and the service would need `get secrets`
 * across all of flux-system. The credential is mounted instead.
 *
 * One transport: http(s). `ssh://` is rejected — see the class comment on
 * GitClient and design §3. The discovered URL is used VERBATIM; the trailing-dot
 * FQDN production needs lives in gitrepository.yaml, not here.
 */
@Injectable()
export class GitRemoteService {
  private readonly logger = new Logger(GitRemoteService.name);
  private cached?: GitRemote;

  constructor(
    private readonly config: ConfigService,
    private readonly customObjectsApi: CustomObjectsApi,
  ) {}

  private get credentialsDir(): string {
    return this.config.get<string>('USER_APPS_GIT_CREDENTIALS_DIR', '/etc/user-apps-git');
  }

  private get workDir(): string {
    return this.config.get<string>('USER_APPS_WORK_DIR', '/var/lib/user-apps');
  }

  async resolve(): Promise<GitRemote> {
    if (this.cached) return this.cached;

    const { url, branch } = await this.resolveLocation();
    if (url.startsWith('ssh://')) {
      throw new Error(
        `the app-store remote is ${url}, but the ssh transport is not supported in ` +
          'this release — repoint GitRepository/user-apps-source at an http(s) URL ' +
          '(see docs/design/2026-08-19-per-app-flux-isolation-design.md §3)',
      );
    }
    const auth = await this.httpAuth(url);

    // Cached only on success, so an empty (not-yet-reflected) credential Secret
    // self-heals on the next call instead of poisoning the process.
    this.cached = { url, branch, auth };
    this.logger.log(`user-apps remote: ${url} (branch ${branch})`);
    return this.cached;
  }

  private async resolveLocation(): Promise<{ url: string; branch: string }> {
    // Test/override seam (mirrors SYSTEM_APPS_OVERRIDE). Required by Tier 1,
    // which has no cluster to discover from.
    const override = this.config.get<string>('USER_APPS_GIT_URL', '');
    if (override) {
      return {
        url: override,
        branch: this.config.get<string>('USER_APPS_GIT_BRANCH', 'master'),
      };
    }

    const repo = await this.readGitRepository();
    const url = repo?.spec?.url;
    if (!url) {
      throw new Error(
        'GitRepository/user-apps-source has no spec.url — cannot locate the app-store repo',
      );
    }
    return { url, branch: repo.spec?.ref?.branch ?? 'master' };
  }

  private async readGitRepository(): Promise<GitRepositoryObject> {
    return (await this.customObjectsApi.getNamespacedCustomObject({
      group: 'source.toolkit.fluxcd.io',
      version: 'v1',
      namespace: 'flux-system',
      plural: 'gitrepositories',
      name: 'user-apps-source',
    })) as GitRepositoryObject;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private async httpAuth(url: string): Promise<GitAuth> {
    const fromFile = async (name: string): Promise<string> => {
      const path = join(this.credentialsDir, name);
      return (await this.exists(path)) ? (await readFile(path, 'utf8')).trim() : '';
    };

    const username =
      this.config.get<string>('USER_APPS_GIT_USERNAME', '') || (await fromFile('username'));
    const password =
      this.config.get<string>('USER_APPS_GIT_PASSWORD', '') || (await fromFile('password'));
    if (!username || !password) {
      throw new Error(
        `http(s) remote configured but no username/password in env or ${this.credentialsDir}`,
      );
    }

    // credential.helper=store reads a file, so the secret never enters argv or
    // the remote URL. Encode the components so / or @ cannot corrupt the entry.
    //
    // The authority is taken from the URL AS WRITTEN, not from `new URL(url).host`:
    // the WHATWG parser strips a default port, so `http://gogs…:80/x` would be
    // stored under host `gogs…` while git looks it up under `gogs…:80`. The entry
    // would never match, git would fall back to prompting, and GIT_TERMINAL_PROMPT=0
    // turns that into an auth failure — on production URLs only, since Tier 1's
    // :43000 is not a default port. Any userinfo already in the URL is dropped.
    const parsed = new URL(url);
    const authority = url
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^[^@/]*@/, '')
      .split('/')[0];
    const entry =
      `${parsed.protocol}//${encodeURIComponent(username)}:` +
      `${encodeURIComponent(password)}@${authority}`;

    await mkdir(this.workDir, { recursive: true, mode: 0o700 });
    const file = join(this.workDir, '.git-credentials');
    await writeFile(file, `${entry}\n`, { mode: 0o600 });
    await chmod(file, 0o600);

    return {
      env: {},
      configArgs: ['-c', `credential.helper=store --file=${file}`],
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/git-remote.service.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/git-remote.service.ts ui/packages/server/src/installed/git-remote.service.spec.ts
git commit -m "feat(marketplace-ui): discover the user-apps remote from GitRepository, authenticate over http (#182)"
```

---

### Task 3: `UserAppsRepoService` — working copy + reads

**Files:**
- Create: `ui/packages/server/src/installed/user-apps-repo.service.ts`
- Test: `ui/packages/server/src/installed/user-apps-repo.service.spec.ts`

**Interfaces:**
- Consumes: `GitClient` (Task 1), `GitRemoteService`/`GitRemote` (Task 2).
- Produces:
  ```ts
  export class UserAppsRepoService {
    constructor(config: ConfigService, git: GitClient, remote: GitRemoteService)
    listInstalledApps(): Promise<string[]>
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `ui/packages/server/src/installed/user-apps-repo.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { GitClient } from './git-client';
import { GitRemoteService } from './git-remote.service';
import { UserAppsRepoService } from './user-apps-repo.service';

const NO_AUTH = { env: {}, configArgs: [] };

/**
 * Address a fixture origin as a URL, never as a bare path — `clone --depth 1` on a
 * local path silently ignores --depth, which would leave the shallow behaviours
 * production depends on untested. Exported: Tasks 4 and 5 append to this file.
 */
export const fileUrl = (path: string): string => `file://${path}`;

/** Bare "remote" seeded with README.md + the given files (path → content). Returns its PATH. */
export async function seedOrigin(
  root: string,
  files: Record<string, string>,
): Promise<string> {
  const git = new GitClient();
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  await git.run(root, ['init', '--bare', '--initial-branch=master', origin]);
  await mkdir(seed, { recursive: true });
  await git.run(seed, ['init', '--initial-branch=master']);
  for (const [rel, content] of Object.entries({ 'README.md': '# user apps\n', ...files })) {
    await mkdir(join(seed, rel, '..'), { recursive: true });
    await writeFile(join(seed, rel), content);
  }
  await git.stageAll(seed);
  await git.commit(seed, 'Initial commit');
  await git.run(seed, ['push', origin, 'master']);
  return origin;
}

export function makeService(root: string, origin: string): UserAppsRepoService {
  const config = {
    get: (key: string, fallback?: string) =>
      ({ USER_APPS_WORK_DIR: join(root, 'work') } as Record<string, string>)[key] ?? fallback,
  } as unknown as ConfigService;
  const remote = {
    resolve: async () => ({ url: fileUrl(origin), branch: 'master', auth: NO_AUTH }),
  } as unknown as GitRemoteService;
  return new UserAppsRepoService(config, new GitClient(), remote);
}

describe('UserAppsRepoService reads', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'user-apps-repo-spec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('lists app directory names under apps/', async () => {
    const origin = await seedOrigin(root, {
      'apps/baikal/release.yaml': 'kind: Kustomization\n',
      'apps/vaultwarden/release.yaml': 'kind: Kustomization\n',
    });
    const svc = makeService(root, origin);

    expect((await svc.listInstalledApps()).sort()).toEqual(['baikal', 'vaultwarden']);
  });

  it('returns [] for a repo with no apps/ directory (fresh cluster)', async () => {
    const svc = makeService(root, await seedOrigin(root, {}));
    expect(await svc.listInstalledApps()).toEqual([]);
  });

  it('ignores loose files directly under apps/', async () => {
    const origin = await seedOrigin(root, {
      'apps/notes.txt': 'not an app\n',
      'apps/baikal/release.yaml': 'kind: Kustomization\n',
    });
    const svc = makeService(root, origin);
    expect(await svc.listInstalledApps()).toEqual(['baikal']);
  });

  it('serves a STALE working copy when git becomes unreachable', async () => {
    const origin = await seedOrigin(root, { 'apps/baikal/release.yaml': 'kind: K\n' });
    const svc = makeService(root, origin);
    expect(await svc.listInstalledApps()).toEqual(['baikal']);

    // Origin disappears; a cached working copy must still answer.
    await rm(origin, { recursive: true, force: true });
    svc.invalidateFreshness();
    expect(await svc.listInstalledApps()).toEqual(['baikal']);
  });

  it('returns [] when git is unreachable and no working copy exists (cold start)', async () => {
    const svc = makeService(root, join(root, 'never-existed.git'));
    expect(await svc.listInstalledApps()).toEqual([]);
  });

  it('does not fetch again within the freshness window', async () => {
    const origin = await seedOrigin(root, { 'apps/baikal/release.yaml': 'kind: K\n' });
    const svc = makeService(root, origin);
    await svc.listInstalledApps();

    const spy = vi.spyOn(GitClient.prototype, 'fetchAndReset');
    await svc.listInstalledApps();
    await svc.listInstalledApps();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/user-apps-repo.service.spec.ts`
Expected: FAIL — cannot resolve `./user-apps-repo.service`.

- [ ] **Step 3: Write the implementation**

Create `ui/packages/server/src/installed/user-apps-repo.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readdir, mkdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitClient } from './git-client';
import { GitRemoteService } from './git-remote.service';

const FRESHNESS_MS = 10_000;

/**
 * The app-store repo, expressed in app terms.
 *
 * "Installed" means `apps/<name>/` exists in the tree — there is no shared root
 * kustomization.yaml any more; Flux auto-generates one from the whole tree, so
 * an app's presence IS its declaration. Reads are served from a persistent
 * shallow clone refreshed on a freshness window; writes always fetch first.
 */
@Injectable()
export class UserAppsRepoService {
  private readonly logger = new Logger(UserAppsRepoService.name);
  private lastFetchMs = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly git: GitClient,
    private readonly remote: GitRemoteService,
  ) {}

  private get workDir(): string {
    return this.config.get<string>('USER_APPS_WORK_DIR', '/var/lib/user-apps');
  }

  private get repoDir(): string {
    return join(this.workDir, 'repo');
  }

  /** Force the next read to re-fetch. Used by tests and after every write. */
  invalidateFreshness(): void {
    this.lastFetchMs = 0;
  }

  private async hasWorkingCopy(): Promise<boolean> {
    try {
      await access(join(this.repoDir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring the working copy in line with the remote.
   * `required` = a write is about to happen, so failure must throw rather than
   * silently operate on a stale tree.
   */
  private async syncWorkingCopy(required: boolean): Promise<boolean> {
    // Misconfiguration (bad credentials, no spec.url) should be loud; an
    // unreachable remote should not be. A read must never 500 on a cold start.
    let remote: GitRemote;
    try {
      remote = await this.remote.resolve();
    } catch (error: unknown) {
      if (required) throw error;
      this.logger.warn(
        'cannot resolve the app-store remote: ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }

    const fresh = Date.now() - this.lastFetchMs < FRESHNESS_MS;
    const present = await this.hasWorkingCopy();

    if (present && fresh && !required) return true;

    try {
      if (!present) {
        await mkdir(this.workDir, { recursive: true });
        await rm(this.repoDir, { recursive: true, force: true });
        await this.git.clone(remote.url, this.repoDir, remote.branch, remote.auth);
      } else {
        await this.git.fetchAndReset(this.repoDir, remote.branch, remote.auth);
      }
      this.lastFetchMs = Date.now();
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // A broken working copy must not wedge the service: drop it so the next
      // attempt clones cleanly.
      if (present) {
        await rm(this.repoDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (required) throw new Error(`app-store repo unavailable: ${message}`);
      this.logger.warn(`app-store repo sync failed: ${message}`);
      return false;
    }
  }

  async listInstalledApps(): Promise<string[]> {
    // A failed refresh with a usable working copy is fine for a read: a stale
    // but true list beats falsely reporting nothing installed.
    const synced = await this.syncWorkingCopy(false);
    if (!synced && !(await this.hasWorkingCopy())) return [];

    try {
      const entries = await readdir(join(this.repoDir, 'apps'), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return []; // no apps/ directory yet
    }
  }
}
```

Import the `GitRemote` type alongside the service:
`import { GitRemoteService, type GitRemote } from './git-remote.service';`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/user-apps-repo.service.spec.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/user-apps-repo.service.ts ui/packages/server/src/installed/user-apps-repo.service.spec.ts
git commit -m "feat(marketplace-ui): read installed apps from a git working copy (#182)"
```

---

### Task 4: `UserAppsRepoService` — atomic writes

**Files:**
- Modify: `ui/packages/server/src/installed/user-apps-repo.service.ts`
- Test: `ui/packages/server/src/installed/user-apps-repo.service.spec.ts` (append a describe block)

**Interfaces:**
- Produces:
  ```ts
  writeApp(name: string, files: Record<string, string>): Promise<void>
  removeApp(name: string): Promise<void>
  ```
  `files` keys are file names relative to `apps/<name>/`, e.g. `{'source.yaml': '...', 'release.yaml': '...'}`.

- [ ] **Step 1: Write the failing test**

Append to `ui/packages/server/src/installed/user-apps-repo.service.spec.ts`:

```ts
describe('UserAppsRepoService writes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'user-apps-write-spec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Read a path out of the origin, proving the change was actually pushed. */
  async function inOrigin(origin: string, rel: string): Promise<string> {
    const { stdout } = await new GitClient().run(origin, ['show', `master:${rel}`]);
    return stdout;
  }

  it('writes an app as ONE commit containing all its files', async () => {
    const origin = await seedOrigin(root, {});
    const svc = makeService(root, origin);

    await svc.writeApp('vaultwarden', {
      'source.yaml': 'kind: OCIRepository\n',
      'release.yaml': 'kind: Kustomization\n',
      'kustomization.yaml': 'resources:\n  - source.yaml\n',
    });

    expect(await inOrigin(origin, 'apps/vaultwarden/source.yaml')).toContain('OCIRepository');
    expect(await inOrigin(origin, 'apps/vaultwarden/release.yaml')).toContain('Kustomization');
    const { stdout: log } = await new GitClient().run(origin, ['log', '--oneline', 'master']);
    expect(log.trim().split('\n')).toHaveLength(2); // seed + one install commit
  });

  it('removeApp deletes the whole app directory in one commit', async () => {
    const origin = await seedOrigin(root, {
      'apps/baikal/release.yaml': 'kind: Kustomization\n',
      'apps/baikal/kustomization.yaml': 'resources: []\n',
    });
    const svc = makeService(root, origin);

    await svc.removeApp('baikal');

    const { stdout } = await new GitClient().run(origin, ['ls-tree', '-r', '--name-only', 'master']);
    expect(stdout).not.toContain('apps/baikal');
    expect(stdout).toContain('README.md');
  });

  it('retries the push after a concurrent commit lands on the remote', async () => {
    const origin = await seedOrigin(root, {});
    const svc = makeService(root, origin);
    await svc.listInstalledApps(); // establish the working copy

    // Simulate a human pushing between our fetch and our push: the first push
    // is rejected non-fast-forward, the retry re-fetches and re-applies.
    const git = new GitClient();
    const other = join(root, 'other');
    await git.clone(fileUrl(origin), other, 'master', NO_AUTH);
    await mkdir(join(other, 'apps', 'manual'), { recursive: true });
    await writeFile(join(other, 'apps/manual/release.yaml'), 'kind: Kustomization\n');
    await git.stageAll(other);
    await git.commit(other, 'manual edit');
    await git.run(other, ['push', 'origin', 'master'], NO_AUTH);

    await svc.writeApp('litellm', { 'release.yaml': 'kind: Kustomization\n' });

    // BOTH changes survive — the retry must not clobber the other writer.
    const { stdout } = await new GitClient().run(origin, ['ls-tree', '-r', '--name-only', 'master']);
    expect(stdout).toContain('apps/litellm/release.yaml');
    expect(stdout).toContain('apps/manual/release.yaml');
  });

  it('throws (and writes nothing) when the remote is unreachable', async () => {
    const svc = makeService(root, join(root, 'never-existed.git'));
    await expect(
      svc.writeApp('vaultwarden', { 'release.yaml': 'kind: Kustomization\n' }),
    ).rejects.toThrow(/app-store repo unavailable/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/user-apps-repo.service.spec.ts`
Expected: FAIL — `svc.writeApp is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `UserAppsRepoService` (imports: add `writeFile` to the `node:fs/promises` import list):

```ts
  /**
   * Apply an idempotent mutation to the repo as exactly one commit.
   *
   * `mutate` must be idempotent because it is replayed on a push retry: a
   * non-fast-forward rejection means someone else committed, so we hard-reset to
   * the new origin tip and re-apply. Resetting BEFORE re-applying is what keeps
   * the other writer's commit intact.
   */
  private async commitAndPush(message: string, mutate: () => Promise<void>): Promise<void> {
    const remote = await this.remote.resolve();
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      await this.syncWorkingCopy(true);
      await mutate();
      await this.git.stageAll(this.repoDir);
      const committed = await this.git.commit(this.repoDir, message);
      this.invalidateFreshness();
      if (!committed) return; // already in the desired state

      try {
        await this.git.push(this.repoDir, remote.branch, remote.auth);
        return;
      } catch (error: unknown) {
        lastError = error;
        this.logger.warn(
          `push rejected (attempt ${attempt + 1}/2), re-syncing and retrying: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async writeApp(name: string, files: Record<string, string>): Promise<void> {
    await this.commitAndPush(`install ${name}`, async () => {
      const dir = join(this.repoDir, 'apps', name);
      await mkdir(dir, { recursive: true });
      for (const [file, content] of Object.entries(files)) {
        await writeFile(join(dir, file), content);
      }
    });
  }

  async removeApp(name: string): Promise<void> {
    await this.commitAndPush(`uninstall ${name}`, async () => {
      await this.git.removePath(this.repoDir, `apps/${name}`);
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/user-apps-repo.service.spec.ts`
Expected: PASS — 10 tests total in the file.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/user-apps-repo.service.ts ui/packages/server/src/installed/user-apps-repo.service.spec.ts
git commit -m "feat(marketplace-ui): install/uninstall as one atomic commit each (#182)"
```

---

### Task 5: One-time layout migration

**Files:**
- Modify: `ui/packages/server/src/installed/user-apps-repo.service.ts`
- Test: `ui/packages/server/src/installed/user-apps-repo.service.spec.ts` (append a describe block)

**Interfaces:**
- Produces: `migrateLayout(): Promise<void>` and `onModuleInit(): Promise<void>`.

**Why this is mandatory:** on an existing cluster the old root `kustomization.yaml` is an *allow-list*. If it survives the upgrade, newly installed apps are not in it and are applied to nothing. And because Flux now auto-generates from the whole tree, orphaned directories left behind by past uninstalls would come back to life — so orphans must be deleted **before** the root file.

- [ ] **Step 1: Write the failing test**

Append to `ui/packages/server/src/installed/user-apps-repo.service.spec.ts`:

```ts
describe('UserAppsRepoService.migrateLayout', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'user-apps-migrate-spec-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const OLD_ROOT = [
    'apiVersion: kustomize.config.k8s.io/v1beta1',
    'kind: Kustomization',
    'resources:',
    '  - apps/baikal',
    '',
  ].join('\n');

  it('deletes the root kustomization.yaml AND orphaned app dirs, keeping listed apps', async () => {
    const origin = await seedOrigin(root, {
      'kustomization.yaml': OLD_ROOT,
      'apps/baikal/release.yaml': 'kind: Kustomization\n',
      // uninstalled earlier: files were left behind, not in resources[]
      'apps/ghost/release.yaml': 'kind: Kustomization\n',
    });
    const svc = makeService(root, origin);

    await svc.migrateLayout();

    const { stdout } = await new GitClient().run(origin, ['ls-tree', '-r', '--name-only', 'master']);
    expect(stdout).not.toContain('apps/ghost');
    expect(stdout.split('\n')).not.toContain('kustomization.yaml');
    expect(stdout).toContain('apps/baikal/release.yaml');
  });

  it('is a no-op on an already-migrated repo (no empty commit)', async () => {
    const origin = await seedOrigin(root, { 'apps/baikal/release.yaml': 'kind: Kustomization\n' });
    const svc = makeService(root, origin);
    const before = (await new GitClient().run(origin, ['rev-parse', 'master'])).stdout.trim();

    await svc.migrateLayout();
    await svc.migrateLayout();

    const after = (await new GitClient().run(origin, ['rev-parse', 'master'])).stdout.trim();
    expect(after).toBe(before);
  });

  it('tolerates a trailing slash in resources entries when classifying orphans', async () => {
    const origin = await seedOrigin(root, {
      'kustomization.yaml': OLD_ROOT.replace('- apps/baikal', '- apps/baikal/'),
      'apps/baikal/release.yaml': 'kind: Kustomization\n',
    });
    const svc = makeService(root, origin);

    await svc.migrateLayout();

    const { stdout } = await new GitClient().run(origin, ['ls-tree', '-r', '--name-only', 'master']);
    expect(stdout).toContain('apps/baikal/release.yaml');
  });

  it('onModuleInit does NOT throw when the remote is unreachable (issue #176 lesson)', async () => {
    const svc = makeService(root, join(root, 'never-existed.git'));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('a later write self-heals the migration that failed at boot', async () => {
    const origin = await seedOrigin(root, {
      'kustomization.yaml': OLD_ROOT,
      'apps/baikal/release.yaml': 'kind: Kustomization\n',
    });
    const svc = makeService(root, origin);

    // Boot-time attempt fails.
    vi.spyOn(GitClient.prototype, 'clone').mockRejectedValueOnce(new Error('git down'));
    await svc.onModuleInit();
    vi.restoreAllMocks();

    await svc.writeApp('litellm', { 'release.yaml': 'kind: Kustomization\n' });

    const { stdout } = await new GitClient().run(origin, ['ls-tree', '-r', '--name-only', 'master']);
    expect(stdout.split('\n')).not.toContain('kustomization.yaml'); // migrated on the way
    expect(stdout).toContain('apps/litellm/release.yaml');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/user-apps-repo.service.spec.ts`
Expected: FAIL — `svc.migrateLayout is not a function`.

- [ ] **Step 3: Write the implementation**

Add `OnModuleInit` to the `@nestjs/common` import, `readFile` to the `node:fs/promises` import, and `import * as yaml from 'js-yaml';`. Change the class declaration to
`export class UserAppsRepoService implements OnModuleInit {` and add:

```ts
  private migrated = false;

  /**
   * Best-effort at boot. MUST NOT throw: a one-shot bootstrap that fails on a
   * cold cluster would leave the container broken for its whole lifetime — that
   * is exactly the #176 failure mode. Writes re-attempt it (see ensureMigrated).
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.migrateLayout();
    } catch (error: unknown) {
      this.logger.warn(
        'app-store layout migration deferred: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private async ensureMigrated(): Promise<void> {
    if (!this.migrated) await this.migrateLayout();
  }

  /**
   * Move an old-shape repo to the auto-generated layout, as one commit:
   *   1. orphaned apps/<name>/ dirs (present but absent from resources[]) — the
   *      root file used to be an allow-list, so these are NOT deployed today and
   *      would spring to life the moment it is removed;
   *   2. the root kustomization.yaml itself.
   * Orphans first: deleting the root file first would briefly make them live.
   * Idempotent — absent root file means nothing to do and no commit.
   */
  async migrateLayout(): Promise<void> {
    await this.commitAndPush('chore: migrate to per-app layout (#182)', async () => {
      const rootFile = join(this.repoDir, 'kustomization.yaml');
      let raw: string;
      try {
        raw = await readFile(rootFile, 'utf8');
      } catch {
        return; // already migrated
      }

      const parsed = yaml.load(raw) as { resources?: string[] } | null;
      const listed = new Set(
        (parsed?.resources ?? []).map((r) => r.replace(/^apps\//, '').replace(/\/$/, '')),
      );

      let present: string[] = [];
      try {
        const entries = await readdir(join(this.repoDir, 'apps'), { withFileTypes: true });
        present = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        present = [];
      }

      for (const name of present) {
        if (!listed.has(name)) {
          this.logger.log(`migration: dropping orphaned app directory apps/${name}`);
          await this.git.removePath(this.repoDir, `apps/${name}`);
        }
      }
      await this.git.removePath(this.repoDir, 'kustomization.yaml');
    });
    this.migrated = true;
  }
```

Then make writes migrate first — in `writeApp` and `removeApp`, insert
`await this.ensureMigrated();` as the first statement of each method.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/user-apps-repo.service.spec.ts`
Expected: PASS — 15 tests total in the file.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/user-apps-repo.service.ts ui/packages/server/src/installed/user-apps-repo.service.spec.ts
git commit -m "feat(marketplace-ui): migrate the app-store repo off the shared root kustomization (#182)"
```

---

### Task 6: Wire it in and delete `GogsService`

**Files:**
- Modify: `ui/packages/server/src/installed/installed.service.ts`
- Modify: `ui/packages/server/src/installed/installed.service.spec.ts`
- Modify: `ui/packages/server/src/installed/installed.module.ts`
- Delete: `ui/packages/server/src/installed/gogs.service.ts`, `ui/packages/server/src/installed/gogs.service.spec.ts`

**Interfaces:**
- Consumes: `UserAppsRepoService.{listInstalledApps,writeApp,removeApp}`.
- Produces: no new public surface; `InstalledService` keeps `enrich/getInstalled/getSystemApps/install/uninstall`.

- [ ] **Step 1: Update the existing spec to the new collaborator**

In `installed.service.spec.ts`, replace the Gogs mock with a repo mock. The
double must expose exactly the three methods `InstalledService` now calls:

```ts
const mockRepo = {
  listInstalledApps: vi.fn(async () => [] as string[]),
  writeApp: vi.fn(async () => undefined),
  removeApp: vi.fn(async () => undefined),
};
```

Replace every `mockGogs.getInstalledAppNames` with `mockRepo.listInstalledApps`,
delete assertions about `ensureWritableToken` (the token no longer exists), and
replace the four `createFile` + `addToRootKustomization` assertions with one:

```ts
it('writes every rendered app file in a single repo write', async () => {
  mockRepo.listInstalledApps.mockResolvedValue([]);

  await service.install('vaultwarden');

  expect(mockRepo.writeApp).toHaveBeenCalledTimes(1);
  const [name, files] = mockRepo.writeApp.mock.calls[0];
  expect(name).toBe('vaultwarden');
  expect(Object.keys(files).sort()).toEqual([
    'kustomization.yaml', 'release.yaml', 'secret.yaml', 'source.yaml',
  ]);
  expect(files['secret.yaml']).not.toContain('${ADMIN_TOKEN}'); // generated
});

it('uninstall removes the app directory', async () => {
  mockRepo.listInstalledApps.mockResolvedValue(['vaultwarden']);

  await service.uninstall('vaultwarden');

  expect(mockRepo.removeApp).toHaveBeenCalledWith('vaultwarden');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/installed.service.spec.ts`
Expected: FAIL — `InstalledService` still injects `GogsService`.

- [ ] **Step 3: Rewrite the call sites**

In `installed.service.ts`:
- Replace `import { GogsService } from './gogs.service';` with
  `import { UserAppsRepoService } from './user-apps-repo.service';`
- Replace the constructor parameter `private readonly gogs: GogsService,` with
  `private readonly repo: UserAppsRepoService,` — **keep it in the same
  positional slot** (second, after `catalog`), so `installed.service.spec.ts`'s
  positional `new InstalledService(...)` construction keeps lining up.
- In `enrich`, `this.gogs.getInstalledAppNames()` → `this.repo.listInstalledApps()`
- In `install`, delete the `await this.gogs.ensureWritableToken();` call and its
  comment block, replace `this.gogs.getInstalledAppNames()` with
  `this.repo.listInstalledApps()`, and replace the whole "4. Render and write
  template files" + "5. Update root kustomization.yaml LAST" section with:

```ts
      // 4. Render every file and write them as ONE commit. Ordering no longer
      // matters ("Pitfall 3" was about the root kustomization.yaml naming an
      // app dir before its files existed) — atomicity now comes from the commit,
      // and Flux auto-generates its kustomization from the tree.
      const files: Record<string, string> = {
        'source.yaml': this.renderTemplate(app.templates.source, vars),
        'release.yaml': this.renderTemplate(app.templates.release, vars),
        'kustomization.yaml': this.renderTemplate(app.templates.kustomization, vars),
      };
      if (app.templates.secret) {
        files['secret.yaml'] = this.renderTemplate(app.templates.secret, vars);
      }
      await this.repo.writeApp(appName, files);
```

- In `uninstall`, delete the `ensureWritableToken` call, replace
  `getInstalledAppNames` with `listInstalledApps`, and replace
  `await this.gogs.removeFromRootKustomization(appName);` with
  `await this.repo.removeApp(appName);`

In `installed.module.ts`, swap the import and provider list. `GitRemoteService`
takes `CustomObjectsApi` by injection (Task 2), and nothing provides it today —
`FluxStatusService` builds its own in `onModuleInit` — so add the factory:

```ts
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
import { GitClient } from './git-client';
import { GitRemoteService } from './git-remote.service';
import { UserAppsRepoService } from './user-apps-repo.service';

// Same kubeconfig selection FluxStatusService.onModuleInit already performs; as a
// factory it can be injected, which is what lets GitRemoteService be unit-tested
// without spying on a private method. Note this runs eagerly at module init, so
// Tier 1's closed-port KUBECONFIG fixture is still what keeps `loadFromDefault()`
// from throwing where no kubeconfig exists — unchanged behaviour, new location.
const customObjectsApiProvider = {
  provide: CustomObjectsApi,
  useFactory: (): CustomObjectsApi => {
    const kc = new KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
    else kc.loadFromDefault();
    return kc.makeApiClient(CustomObjectsApi);
  },
};

// ...
  providers: [
    InstalledService,
    customObjectsApiProvider,
    GitClient,
    GitRemoteService,
    UserAppsRepoService,
    FluxStatusService,
    SystemAppsService,
    LaunchUrlService,
  ],
```

Leave `FluxStatusService` building its own client — migrating it to the provider is
a tidy-up with its own test blast radius, not part of #182.

Then delete the old service and its spec:

```bash
git rm ui/packages/server/src/installed/gogs.service.ts ui/packages/server/src/installed/gogs.service.spec.ts
```

- [ ] **Step 4: Run the full server suite and the build**

Run: `cd ui && npm test --workspace=packages/server`
Expected: PASS, and **no** `GogsService` test file remains.

Run: `cd ui && npm run build:client && npm run build`
Expected: both succeed (`nest build` is the only typecheck gate in this repo).

Run: `cd ui && grep -rn "GogsService\|GOGS_" packages/server/src`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add -A ui/packages/server/src/installed
git commit -m "refactor(marketplace-ui): replace GogsService with the provider-neutral git repo service (#182)"
```

---

### Task 7: RBAC, deployment and configmap

**Files:**
- Modify: `apps/marketplace-ui/base/serviceaccount.yaml`
- Modify: `apps/marketplace-ui/base/deployment.yaml`
- Modify: `apps/marketplace-ui/base/configmap.yaml`
- Modify: `apps/marketplace-ui/base/kustomization.yaml`
- Test: `ui/packages/server/src/installed/rbac-manifest.spec.ts`

**Interfaces:**
- Consumes: env names from Tasks 2–3 (`USER_APPS_GIT_CREDENTIALS_DIR`, `USER_APPS_WORK_DIR`).
- Produces: the cluster wiring the server expects at runtime.

- [ ] **Step 1: Write the failing RBAC test**

In `rbac-manifest.spec.ts`, add one row to the `READS` array:

```ts
  {
    group: 'source.toolkit.fluxcd.io',
    resource: 'gitrepositories',
    readBy: 'GitRemoteService',
  },
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/rbac-manifest.spec.ts`
Expected: FAIL — `grants list on source.toolkit.fluxcd.io/gitrepositories`.

- [ ] **Step 3: Update the manifests**

In `apps/marketplace-ui/base/serviceaccount.yaml`, add to the ClusterRole rules:

```yaml
  # Read-only: GitRemoteService reads spec.url + spec.ref.branch from
  # GitRepository/user-apps-source so the installer always commits to the repo
  # Flux is actually reconciling. Repointing that object at GitHub/GitLab needs
  # no code change. The Secret it references is deliberately NOT read here — its
  # name is dynamic, so RBAC could not scope it and this would need `get secrets`
  # across all of flux-system; the credential is mounted instead.
  - apiGroups: ['source.toolkit.fluxcd.io']
    resources: ['gitrepositories']
    verbs: ['get', 'list', 'watch']
```

In `apps/marketplace-ui/base/deployment.yaml`:
- Replace the stale `wait-for-gogs-user` NOTE block with:

```yaml
      # NOTE: repo readiness is enforced provider-neutrally by the marketplace-ui
      # Kustomization's `dependsOn: user-apps-source`, whose Ready condition is a
      # selective healthCheck on GitRepository/user-apps-source — i.e. "Flux
      # cloned a seeded repo". It deliberately does NOT depend on `user-apps`:
      # that Kustomization builds every installed app's YAML, so one broken app
      # would block re-applying the installer UI (issue #182).
      # The CA-merge initContainer is added by overlays/librepod/deployment-auth-patch.yaml.
```

- Replace the two `GOGS_*` env entries with nothing (they are gone), and mount
  the credential + a work dir:

```yaml
          volumeMounts:
            - name: catalog
              mountPath: /data
              readOnly: true
            # The same credential Flux uses for this repo, as `username`/`password`
            # files (GitRemoteService reads exactly those two names).
            - name: user-apps-git-credentials
              mountPath: /etc/user-apps-git
              readOnly: true
            # Working copy of the app-store repo (shallow clone) + the generated
            # .git-credentials. Disposable: rebuilt on demand.
            - name: user-apps-work
              mountPath: /var/lib/user-apps
```

and in `volumes:`:

```yaml
        # user-apps-git-auth is generated EMPTY by this app's kustomization and
        # filled by Reflector from gogs/user-apps-source-auth. Mounting the
        # reflected Secret directly would make the pod unschedulable whenever it is
        # briefly absent — during a rotation, or during cold-boot-repro.sh, which
        # deletes it in all three namespaces. An empty mount instead lets the pod
        # boot, /api/health answer, reads degrade, and the first write fail loudly.
        - name: user-apps-git-credentials
          secret:
            secretName: user-apps-git-auth
        - name: user-apps-work
          emptyDir: {}
```

In `apps/marketplace-ui/base/kustomization.yaml`, **rename** the placeholder
`secretGenerator` — same mechanism, provider-neutral name, and it stops
`gogs-auth` from being left behind unreferenced:

```yaml
secretGenerator:
- name: user-apps-git-auth
  options:
    disableNameSuffixHash: true
    annotations:
      # Empty on purpose. Reflector mirrors gogs/user-apps-source-auth into it —
      # the same credential Flux authenticates the GitRepository with, so the
      # installer and Flux can never drift apart on WHO they are.
      reflector.v1.k8s.emberstack.com/reflects: "gogs/user-apps-source-auth"
```

`prune: true` on the `marketplace-ui` Kustomization removes the old `gogs-auth`
Secret on the next reconcile. Nothing else references it — verify with
`git grep -n gogs-auth` before deleting the generator, and expect zero hits after.

In `apps/marketplace-ui/base/configmap.yaml`, delete the `GOGS_URL` entry **and
its trailing-dot comment**, and add:

```yaml
  # Where the app-store repo working copy and the private credential copies live
  # (the emptyDir mounted by the Deployment).
  USER_APPS_WORK_DIR: "/var/lib/user-apps"
  USER_APPS_GIT_CREDENTIALS_DIR: "/etc/user-apps-git"
```

> **Do not add `USER_APPS_GIT_URL` here.** It is discovered from
> `GitRepository/user-apps-source`; hardcoding it would let the installer commit
> to a repo Flux is not reading. The env var exists only as a test seam.

- [ ] **Step 4: Verify**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/rbac-manifest.spec.ts`
Expected: PASS.

Run: `kustomize build apps/marketplace-ui/overlays/librepod > /dev/null && echo OK`
Expected: `OK`.

Run: `kustomize build apps/marketplace-ui/overlays/librepod | grep -c "user-apps-git-credentials"`
Expected: `2` (the volume and the mount).

Run: `kustomize build apps/marketplace-ui/overlays/librepod | grep -c "user-apps-git-auth"`
Expected: `2` (the generated Secret and the volume's `secretName`).

Run: `git grep -n "gogs-auth\|GOGS_URL\|GOGS_USERNAME\|GOGS_TOKEN" -- apps/marketplace-ui`
Expected: no output — the Gogs-specific credential surface is gone from this app.

Run: `kustomize build apps/marketplace-ui/overlays/librepod | grep -A3 "name: user-apps-git-auth"`
Expected: the Secret has **no `data:`** — it is a placeholder Reflector fills.

- [ ] **Step 5: Commit**

```bash
git add apps/marketplace-ui/base ui/packages/server/src/installed/rbac-manifest.spec.ts
git commit -m "feat(marketplace-ui): grant gitrepositories read, mount the git credential (#182)"
```

---

### Task 8: The three Flux layers

**Files:**
- Modify: `infrastructure/user-apps-source/user-apps.yaml`
- Modify: `infrastructure/user-apps-source/gitrepository.yaml`
- Modify: `clusters/librepod/user-apps-source.yaml`
- Modify: `clusters/librepod-dev/user-apps-source.yaml`
- Modify: `clusters/librepod-k3d/user-apps-source.yaml`
- Modify: `infrastructure/system-apps/marketplace-ui.yaml`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure manifest change).
- Produces: `user-apps-source` Ready ⇔ the git source is seeded — the gate Task 12's tests assert on — and the `http(s)` URL `GitRemoteService` (Task 2) discovers.

- [ ] **Step 1: Make `user-apps` apply-only**

In `infrastructure/user-apps-source/user-apps.yaml`, replace `wait: true` with:

```yaml
  # Apply-only on purpose. With wait: true Flux health-checks every object it
  # applies — including each per-app Kustomization CR — so ONE unhealthy app
  # turned this shared object Ready=False (issue #182). App health belongs to
  # each marketplace-<app> Kustomization, which keeps its own wait: true.
  wait: false
```

- [ ] **Step 2: Add the selective seeded gate (all three cluster flavours)**

In each of `clusters/librepod/user-apps-source.yaml`,
`clusters/librepod-dev/user-apps-source.yaml`, and
`clusters/librepod-k3d/user-apps-source.yaml`, add after `prune: true`:

```yaml
  # Ready ⇔ Flux cloned a SEEDED repo. `wait: false` + an explicit healthChecks
  # list is a *selective* assessment: the CRD states "Wait instructs the
  # controller to check the health of all the reconciled resources. When enabled,
  # the HealthChecks are ignored." So this checks the GitRepository ONLY — not
  # Kustomization/user-apps, which this same Kustomization also applies and whose
  # health depends on every installed app's YAML.
  # This is what marketplace-ui gates on (issue #180's guarantee, without #182's
  # coupling). Evaluated after apply, so the seed Job it applies is free to be
  # what makes the GitRepository Ready — no deadlock.
  wait: false
  healthChecks:
    - apiVersion: source.toolkit.fluxcd.io/v1
      kind: GitRepository
      name: user-apps-source
      namespace: flux-system
```

**In the same three files, raise `timeout: 5m` → `timeout: 15m`** with this comment:

```yaml
  # 15m, not 5m: `timeout` now bounds a HEALTH CHECK, not just an apply. The
  # GitRepository cannot go Ready until the bootstrap Job has seeded the repo, and
  # that Job alone polls up to 300s for Gogs to accept credentials before it starts
  # working — plus image pull, apk add, a kubectl download, keygen, keyscan and up
  # to five push retries. At 5m the first cold-boot attempt reliably timed out and
  # recovered on retryInterval, so every cold boot showed this gate Ready=False
  # with a timeout error: noise indistinguishable from the failure it exists to
  # catch.
  timeout: 15m
```

- [ ] **Step 3: Move the GitRepository to `http`, with the trailing-dot FQDN**

In `infrastructure/user-apps-source/gitrepository.yaml`, replace the `url` and
`secretRef` (design §4, F13–F15):

```yaml
spec:
  interval: 1m
  # HTTP, not ssh. Three reasons, in order of weight:
  #   1. The installer writes to THIS url (it discovers it from this object), and
  #      the only hermetic test tier reaching Gogs does so over HTTP with no port
  #      22 — so ssh would ship as the one transport no fast test covers.
  #   2. Trailing dot = absolute FQDN. Do NOT remove it. With ndots:5 a 4-dot name
  #      is search-expanded first, and where the app zone is in the pod's search
  #      list that expansion is rewritten to Traefik's ClusterIP by coredns-custom
  #      — the documented reason marketplace-ui's GOGS_URL carried this dot. The
  #      absolute form is correct whether or not a given device is exposed to that,
  #      and an ssh url could not take the dot at all without re-keying
  #      known_hosts, since host keys are bound to the exact name given.
  #   3. ssh was adopted for "no baked-in credential", but the flux account's
  #      password is a committed literal (apps/gogs/components/bootstrap-admin/
  #      secret.env) reflected into two namespaces — the keypair bought ceremony,
  #      not secrecy.
  # Trade-off accepted: basic auth crosses the pod network in plaintext. Revisit
  # when that credential is rotated. See issue #182's design doc §3.
  url: http://gogs.gogs.svc.cluster.local.:80/flux/user-apps.git
  ref:
    branch: master
  secretRef:
    name: user-apps-source-auth
```

`Secret/user-apps-source-auth` already exists in `flux-system` (the gogs
`bootstrap-admin` component generates it and Reflector mirrors it) with exactly the
`username`/`password` keys Flux wants — so this is a manifest-only change with no
new provisioning. `Secret/user-apps-ssh-key` keeps being created and reflected: it
is the bootstrap Job's idempotency guard and `cold-boot-repro.sh`'s lever. It is
simply no longer read by anything. Slimming the Job is a deferred follow-up
(design Deferred), **not** part of this change.

- [ ] **Step 4: Repoint the marketplace-ui gate**

In `infrastructure/system-apps/marketplace-ui.yaml`, replace the `user-apps`
dependency (and its whole comment block) with:

```yaml
    # Gate on user-apps-source, whose Ready is a selective healthCheck on
    # GitRepository/user-apps-source: "Flux cloned a seeded repo". That is the
    # installer's real invariant and it is provider-neutral (identical for Gogs,
    # GitHub, GitLab). It deliberately does NOT gate on `user-apps`: that
    # Kustomization builds every installed app's YAML, so one broken app would
    # block re-applying the installer UI — the very tool needed to remove it
    # (issue #182). dependsOn cannot target a GitRepository directly, so the
    # Kustomization that owns it carries the check. Acyclic: user-apps-source
    # dependsOn system-configs + gogs only.
    - name: user-apps-source
```

- [ ] **Step 5: Verify the manifests build and the gate is wired**

Run:
```bash
nix-shell shell.nix --run "flux build kustomization user-apps-source \
  --dry-run --path ./infrastructure/user-apps-source \
  --kustomization-file ./clusters/librepod/user-apps-source.yaml \
  --local-sources OCIRepository/flux-system/librepod-bootstrap=./" | grep -A4 'kind: Kustomization'
```
Expected: renders; `user-apps` shows `wait: false`.

Run: `grep -c "user-apps-source" infrastructure/system-apps/marketplace-ui.yaml`
Expected: `1`.

Run: `grep -rn "wait: true" infrastructure/user-apps-source/`
Expected: no output.

Run: `for f in clusters/*/user-apps-source.yaml; do grep -q "healthChecks" "$f" || echo "MISSING: $f"; done`
Expected: no output (all three patched).

Run: `grep -c "timeout: 15m" clusters/*/user-apps-source.yaml`
Expected: `1` for each of the three files.

Run: `grep -n "url:\|secretRef" -A1 infrastructure/user-apps-source/gitrepository.yaml`
Expected: `http://gogs.gogs.svc.cluster.local.:80/flux/user-apps.git` (**with** the
trailing dot before the colon) and `name: user-apps-source-auth`.

Run: `git grep -n "ssh://" -- infrastructure clusters apps`
Expected: no output — no manifest still points Flux at the ssh transport.

**Settle design F13's open question while you are here** (one command, and it
determines whether the trailing dot is a nicety or a necessity):

```bash
kubectl exec -n marketplace-ui deploy/marketplace-ui -c marketplace-ui -- cat /etc/resolv.conf
```
Run it on a **device**, not the dev cluster. If `search` includes the app zone, the
dot is load-bearing and `configmap.yaml`'s comment is right. If it does not, the
dot is harmless insurance and that comment should be corrected to say what actually
broke. Record the answer in the design doc's F13 either way — leaving it open is
how the next person re-litigates it.

- [ ] **Step 6: Commit**

```bash
git add infrastructure/user-apps-source/user-apps.yaml infrastructure/user-apps-source/gitrepository.yaml clusters/*/user-apps-source.yaml infrastructure/system-apps/marketplace-ui.yaml
git commit -m "fix(marketplace-ui): isolate app health, gate on a seeded source, clone over http (#182)"
```

---

### Task 9: Stop seeding the shared root file

**Files:**
- Modify: `infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a freshly seeded repo containing only `README.md`, which Flux builds
  clean and empty (verified: design F5) so the gate still opens on a zero-app
  cluster.

**Why:** leaving the seed as-is would give every *fresh* cluster a root
`kustomization.yaml` with `resources: []` — an empty allow-list, so nothing would
ever deploy. (An existing cluster is handled by Task 5's migration; this is the
fresh-install half.)

- [ ] **Step 1: Drop `kustomization.yaml` from the seed commit**

In the `if [ "$REPO_EMPTY" = "1" ]` block, delete the `cat > kustomization.yaml`
heredoc, and change the `git add` line to `git add README.md`. Update the README
body to describe the new layout:

```sh
  cat > README.md <<'MD'
# LibrePod user apps

This repository holds user-installed apps for this LibrePod cluster. Each app is
a directory under `apps/<name>/` containing its Flux objects. There is no root
`kustomization.yaml`: FluxCD generates one from the whole tree, so an app's
presence IS its declaration — adding a directory installs it, removing the
directory uninstalls it.

One consequence worth knowing before editing by hand: because the whole tree is
the build input, a malformed YAML file anywhere in it fails the build for every
app. The marketplace UI writes exactly one app directory per commit.

Managed by the LibrePod marketplace UI. FluxCD reconciles this repo into the
cluster.
MD
```

> **Do not** write "one app's files cannot affect another's" here, however
> tempting. Design F6/F7 verified the opposite: auto-generation decodes every YAML
> file in the tree, so one malformed file — or two apps declaring the same resource
> ID — fails the build for all of them. Dropping the root file buys atomicity and
> real deletion, and #182's isolation win is at the *health* layer (Task 8), not
> the build layer. A README that overclaims here will send the next person
> debugging a whole-repo build failure in the wrong direction.

Also update the seed comment above it:

```sh
# Seed the initial commit so Flux's user-apps Kustomization (path ./, branch
# master, prune) has a valid target from day one. README.md ONLY — deliberately
# no root kustomization.yaml: Flux auto-generates one from the tree, and a
# committed `resources: []` would be an empty ALLOW-LIST that silently prevents
# every future install from being applied (issue #182). A README-only repo
# builds clean and empty, so the seeded-source health gate still opens on a
# cluster with zero apps installed.
```

- [ ] **Step 2: Correct the script's header comment (Flux no longer uses the key)**

The first line reads *"so Flux's GitRepository/user-apps-source can clone
flux/user-apps.git over SSH instead of HTTP basic auth"* — the reverse is now true
(Task 8). Rewrite the opening paragraph to say what the Job actually provides and
why the keypair is still here:

```sh
# Bootstraps the flux/user-apps repo: creates it if missing, seeds its first commit,
# and provisions Secret/user-apps-ssh-key (ed25519 keypair + Gogs host known_hosts).
#
# NOTE ON THE KEYPAIR: since #182 Flux clones this repo over HTTP with
# Secret/user-apps-source-auth, and the marketplace-ui installer writes to the same
# HTTP url — so NOTHING currently reads the keypair. It is still provisioned because
# (a) the Secret's existence is this Job's idempotency guard and the operator's
# override hook, (b) cold-boot-repro.sh deletes it to force a reseed, and (c) it is
# the provisioning half of the deferred ssh transport. Removing it is a follow-up
# with its own cold-boot verification — see the design doc's Deferred section.
```

- [ ] **Step 3: Fix the false claim in the AUTH NOTE**

The note claims `DELETE` works on the contents API. It does not — three request
shapes were live-probed and all returned an unrouted HTML `404`, which is the
reason this whole change needs a git client. Replace that bullet:

```sh
#   - raw / contents : GET /api/v1/repos/.../raw/...       → token <sha1>: 200 OK
#                      PUT /api/v1/repos/.../contents/...  → token <sha1>: 201 OK
#     NOTE: there is NO DELETE route on the contents API in this gogs release —
#     a DELETE returns an unrouted HTML 404 (live-probed, issue #182). File
#     REMOVAL is therefore impossible over this API, which is why the installer
#     performs all repo mutations over git instead of the provider's REST API.
```

- [ ] **Step 4: Verify**

Run: `bash -n infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh && echo "syntax OK"`
Expected: `syntax OK`.

Run: `grep -c "cat > kustomization.yaml" infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`
Expected: `0`.

Run: `grep -n "git add" infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`
Expected: `git add README.md` only.

Run: `grep -n "cannot affect" infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`
Expected: no output (the overclaim never made it into the seeded README).

Run: `grep -n "instead of HTTP basic auth" infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`
Expected: no output (the header no longer describes the old transport).

Run: `kustomize build infrastructure/user-apps-source > /dev/null && echo OK`
Expected: `OK` (the script is embedded via configMapGenerator).

- [ ] **Step 5: Commit**

```bash
git add infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh
git commit -m "fix(user-apps-source): seed README only, never a root kustomization allow-list (#182)"
```

---

### Task 10: Ship `git` in the image

**Files:**
- Modify: `ui/Dockerfile`

**Interfaces:**
- Consumes: `GitClient` spawns `git`.
- Produces: a runtime image with `git` — and deliberately **without** `openssh-client`.

- [ ] **Step 1: Add the package to the production stage**

In the `FROM node:22-alpine AS production` stage, immediately after `WORKDIR /app`:

```dockerfile
# The installer performs every app-store repo mutation over git (the provider's
# REST contents API has no DELETE route, so file removal is impossible there —
# see issue #182). git only: the app-store remote is an http(s) URL, and the ssh
# transport is deliberately not shipped in this release (design §3), so
# openssh-client would be unused attack surface.
RUN apk add --no-cache git
```

- [ ] **Step 2: Build and verify the binary set**

Run:
```bash
docker build -t marketplace-ui:182-check ui
docker run --rm --entrypoint sh marketplace-ui:182-check -c 'git --version'
```
Expected: a git version line, exit 0.

Run:
```bash
docker run --rm --entrypoint sh marketplace-ui:182-check -c 'command -v ssh && echo UNEXPECTED || echo "no ssh, as intended"'
```
Expected: `no ssh, as intended`. This is a guard, not trivia — if `ssh` reappears
it means someone re-added the untested transport.

- [ ] **Step 3: Verify the server still boots in the image**

Run:
```bash
docker run --rm --entrypoint sh marketplace-ui:182-check -c 'test -f packages/server/dist/main.js && echo dist OK'
```
Expected: `dist OK`.

- [ ] **Step 4: Commit**

```bash
git add ui/Dockerfile
git commit -m "build(marketplace-ui): install git in the runtime image (#182)"
```

---

### Task 11: Tier 1 e2e — install, uninstall, migration

**Files:**
- Modify: `ui/packages/e2e/projects/tier1.config.ts`
- Modify: `ui/packages/e2e/support/gogs/seed.sh`
- Create: `ui/packages/e2e/tests/app-level/repo-layout.spec.ts`

**Interfaces:**
- Consumes: `USER_APPS_GIT_URL` / `USER_APPS_GIT_USERNAME` / `USER_APPS_GIT_PASSWORD` (Task 2), `writeApp`/`removeApp` (Task 4), `migrateLayout` (Task 5).
- Produces: hermetic proof that uninstall now really deletes files and that an old-shape repo migrates.

**Why Tier 1 can do this now:** its Gogs is reached over HTTP on 43000 (no port
22), and it has no cluster — so the env override is mandatory. Since Task 8 makes
`http` the shipped transport, this tier now exercises the **production credential
path**, not a test-only concession. That is the whole point of the transport
decision: the fast, hermetic tier and the cluster run the same code.

One thing Tier 1 still cannot catch, so do not read it as full coverage: its URL
uses port **43000**, a non-default port. The default-port credential bug guarded by
`git-remote.service.spec.ts` (`http://…:80` → `URL.host` drops the `:80`) is
invisible here. That guard lives in the unit tests on purpose.

- [ ] **Step 1: Point the server at the git remote**

In `tier1.config.ts`, replace the three `GOGS_*` entries in `webServer.env` with:

```ts
      // The installer performs repo mutations over git, not the provider API.
      // Tier 1 has no cluster, so GitRepository discovery is impossible — this
      // override is the documented test seam. Same transport as production (http);
      // the compose maps only 43000 → gogs:3000 and there is no port 22.
      USER_APPS_GIT_URL: "http://127.0.0.1:43000/flux/user-apps.git",
      USER_APPS_GIT_BRANCH: "master",
      USER_APPS_GIT_USERNAME: "flux",
      USER_APPS_GIT_PASSWORD: "pass@w0rd",
      USER_APPS_WORK_DIR: `${process.cwd()}/packages/e2e/.tmp/user-apps-work`,
      USER_APPS_GIT_CREDENTIALS_DIR: `${process.cwd()}/packages/e2e/.tmp/user-apps-creds`,
```

Add `packages/e2e/.tmp/` to `ui/packages/e2e/.gitignore` if not already covered.

- [ ] **Step 2: Seed the OLD shape plus an orphan, so migration is exercised**

In `support/gogs/seed.sh`, where it creates the root `kustomization.yaml`, keep
that file (Tier 1 deliberately starts in the pre-#182 shape) and add an orphan
directory that is **not** listed in `resources:`. Add this comment above it:

```sh
# Tier 1 starts in the PRE-#182 layout on purpose: a root kustomization.yaml
# allow-list plus an orphaned app dir left behind by an "earlier uninstall".
# The server migrates this at boot (UserAppsRepoService.migrateLayout), and
# tests/app-level/repo-layout.spec.ts asserts the result — so the migration path
# is covered end-to-end, not just in unit tests.
```

The script already clones over HTTP and pushes with git, so extend that same
commit. Replace the three lines from `printf 'apiVersion: …' > kustomization.yaml`
through the `git add kustomization.yaml` with:

```sh
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: []\n' > kustomization.yaml
# An app dir deliberately ABSENT from resources[] above — i.e. left behind by an
# earlier uninstall, which the pre-#182 code could not delete. migrateLayout()
# must drop it, otherwise Flux's auto-generated kustomization would resurrect it.
# `orphan-probe` is not in fixtures/catalog.fixture.yaml, so no other spec can
# observe it.
mkdir -p apps/orphan-probe
printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: orphan-probe\n' > apps/orphan-probe/release.yaml
git add kustomization.yaml apps/orphan-probe
```

- [ ] **Step 3: Write the failing spec**

Create `ui/packages/e2e/tests/app-level/repo-layout.spec.ts`:

```ts
import { test, expect, type APIRequestContext } from "@playwright/test";

const GOGS = "http://127.0.0.1:43000";
const AUTH = "Basic " + Buffer.from("flux:pass@w0rd").toString("base64");

/** Mint a Gogs token: raw/contents reads need `token <sha1>`, not Basic. */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${GOGS}/api/v1/users/flux/tokens`, {
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    data: { name: `tier1-layout-${Date.now()}` },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).sha1;
}

async function listPaths(request: APIRequestContext, tok: string): Promise<string[]> {
  const res = await request.get(
    `${GOGS}/api/v1/repos/flux/user-apps/git/trees/master?recursive=1`,
    { headers: { Authorization: `token ${tok}` } },
  );
  expect(res.ok()).toBeTruthy();
  return ((await res.json()).tree ?? []).map((e: { path: string }) => e.path);
}

test.describe("app-store repo layout (#182)", () => {
  test("the server migrated the repo off the shared root kustomization at boot", async ({ request }) => {
    const paths = await listPaths(request, await token(request));

    expect(paths).not.toContain("kustomization.yaml");
    // the orphan the seed planted (not in the old resources[] list) is gone
    expect(paths.filter((p) => p.startsWith("apps/orphan-probe"))).toEqual([]);
    expect(paths).toContain("README.md");
  });

  test("install writes only the app's own directory; uninstall deletes it", async ({ request }) => {
    const tok = await token(request);

    const before = await listPaths(request, tok);
    expect(before.filter((p) => p.startsWith("apps/vaultwarden"))).toEqual([]);

    const install = await request.post("/api/apps/vaultwarden/install");
    expect(install.ok()).toBeTruthy();

    const after = await listPaths(request, tok);
    expect(after).toContain("apps/vaultwarden/release.yaml");
    expect(after).toContain("apps/vaultwarden/source.yaml");
    expect(after).not.toContain("kustomization.yaml"); // no shared root file
    expect(await request.get("/api/apps/vaultwarden").then((r) => r.json()))
      .toMatchObject({ installedStatus: expect.any(String) });

    const uninstall = await request.post("/api/apps/vaultwarden/uninstall");
    expect(uninstall.ok()).toBeTruthy();

    // The pre-#182 uninstall only edited the root file and LEFT these files
    // behind (the provider API cannot delete). They must be gone now.
    const final = await listPaths(request, tok);
    expect(final.filter((p) => p.startsWith("apps/vaultwarden"))).toEqual([]);
  });
});
```

- [ ] **Step 4: Run Tier 1**

Run: `cd ui && npm run test:e2e:ui -- tests/app-level/repo-layout.spec.ts`
Expected: 2 passed.

Run: `cd ui && npm run test:e2e:ui`
Expected: the whole Tier 1 suite passes. Specs asserting a clean slate uninstall
leftovers first; because uninstall now deletes files, re-check `my-apps` and
`resilience` still pass and fix their setup if they relied on files persisting.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/e2e
git commit -m "test(marketplace-ui): cover git-backed install/uninstall and the layout migration in Tier 1 (#182)"
```

---

### Task 12: Tier 2 — broken-app isolation (the acceptance test)

**Files:**
- Create: `ui/packages/e2e/tests/cluster-level/broken-app-isolation.spec.ts`
- Modify: `ui/packages/e2e/support/cold-boot-repro.sh`
- Modify: `ui/packages/e2e/support/run-tier2.sh`

**Interfaces:**
- Consumes: the Flux layers from Task 8.
- Produces: the executable form of #182's acceptance criterion.

- [ ] **Step 1: Write the failing spec**

Create `ui/packages/e2e/tests/cluster-level/broken-app-isolation.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

/**
 * #182's acceptance criterion, executable: ONE broken app must not turn any
 * shared Flux object Ready=False.
 *
 * THE BREAK IS DECLARATIVE — committed to the app-store repo, never patched onto
 * the live object. A `kubectl patch` of the app's OCIRepository is reverted by
 * kustomize-controller's drift correction within one `user-apps` interval (1m,
 * design F16), so a patch-based version of this test races its own assertions and
 * flakes. Committing the break makes it the DESIRED state: Flux enforces it
 * instead of healing it. It also exercises the new "presence in the repo IS the
 * declaration" contract, which is the other half of #182.
 *
 * The probe app is synthetic and absent from the catalog, so `enrich()` never
 * surfaces it and no other spec can observe it — which is also why it does not
 * collide with `reconcile-lifecycle.spec.ts`'s `pickApp()` app the way breaking a
 * real app would. Nothing to clean up: this gogs release has no DELETE route
 * (design F8) and `run-tier2.sh` destroys the cluster — and with it the in-cluster
 * Gogs — at the end of the run.
 */
const APP = "broken-probe-182";
const NS = "marketplace-ui";

function kubectl(args: string[]): string {
  return execFileSync("kubectl", args, { encoding: "utf8" });
}

/** Strict: throws if the object is missing. Use for the real assertions. */
function ready(kind: string, name: string): string {
  return kubectl([
    "get", kind, name, "-n", "flux-system",
    "-o", 'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
  ]).trim();
}

/** Tolerant: "absent" until Flux has applied it. Use only inside expect.poll. */
function readyOrAbsent(kind: string, name: string): string {
  try {
    return ready(kind, name);
  } catch {
    return "absent";
  }
}

/**
 * Valid YAML that applies cleanly and can never become Ready: the OCI tag does not
 * exist, so the OCIRepository never produces an artifact. Keeping the YAML VALID is
 * essential — malformed YAML fails the whole-tree build (design F6) and would turn
 * `user-apps` Ready=False, destroying this test's premise instead of testing it.
 */
function brokenAppFiles(): Record<string, string> {
  const meta = (kind: string, apiVersion: string) => [
    `apiVersion: ${apiVersion}`,
    `kind: ${kind}`,
    "metadata:",
    `  name: marketplace-${APP}`,
    "  namespace: flux-system",
    "  labels:",
    `    marketplace.io/app: ${APP}`,
  ];
  return {
    [`apps/${APP}/source.yaml`]: [
      ...meta("OCIRepository", "source.toolkit.fluxcd.io/v1"),
      "spec:",
      "  interval: 1m",
      "  url: oci://ghcr.io/librepod/marketplace/apps/whoami",
      "  ref:",
      '    tag: "0.0.0-does-not-exist"',
      "",
    ].join("\n"),
    [`apps/${APP}/release.yaml`]: [
      ...meta("Kustomization", "kustomize.toolkit.fluxcd.io/v1"),
      "spec:",
      "  interval: 1m",
      "  retryInterval: 1m",
      "  timeout: 2m",
      "  sourceRef:",
      "    kind: OCIRepository",
      `    name: marketplace-${APP}`,
      "  path: ./overlays/librepod",
      "  prune: true",
      "  wait: true",
      "",
    ].join("\n"),
    [`apps/${APP}/kustomization.yaml`]: [
      "apiVersion: kustomize.config.k8s.io/v1beta1",
      "kind: Kustomization",
      "resources:",
      "  - source.yaml",
      "  - release.yaml",
      "",
    ].join("\n"),
  };
}

/**
 * Commit `apps/<APP>/` through the Gogs contents API, executed from INSIDE the
 * server pod — the same route `run-tier2.sh`'s diagnostics take, and the only one
 * with both the credential and in-cluster DNS. PUT to a path that does not exist
 * creates it (201), so no `sha` read-modify-write is needed. Basic auth mints the
 * token; contents needs `token <sha1>` (the #180 auth matrix).
 */
function commitBrokenApp(): void {
  const pod = kubectl([
    "get", "pods", "-n", NS, "-l", "app.kubernetes.io/name=marketplace-ui",
    "-o", "jsonpath={.items[0].metadata.name}",
  ]).trim();

  const script = `
    const { readFileSync } = require('node:fs');
    const dir = process.env.USER_APPS_GIT_CREDENTIALS_DIR || '/etc/user-apps-git';
    const u = readFileSync(dir + '/username', 'utf8').trim();
    const p = readFileSync(dir + '/password', 'utf8').trim();
    const G = 'http://gogs.gogs.svc.cluster.local.:80';
    const files = ${JSON.stringify(brokenAppFiles())};
    (async () => {
      const t = await fetch(G + '/api/v1/users/' + u + '/tokens', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(u + ':' + p).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'broken-probe-' + process.pid }),
      });
      if (!t.ok) throw new Error('token mint -> ' + t.status);
      const tok = (await t.json()).sha1;
      for (const [path, content] of Object.entries(files)) {
        const r = await fetch(G + '/api/v1/repos/' + u + '/user-apps/contents/' + path, {
          method: 'PUT',
          headers: { Authorization: 'token ' + tok, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'test: plant a deliberately broken app (#182)',
            content: Buffer.from(content).toString('base64'),
          }),
        });
        if (!r.ok) throw new Error('PUT ' + path + ' -> ' + r.status);
      }
      console.log('planted');
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;

  expect(
    kubectl(["exec", "-n", NS, pod, "-c", "marketplace-ui", "--", "node", "-e", script]),
  ).toContain("planted");
}

test.describe("broken-app isolation (#182)", () => {
  // Longer than the other cluster specs: it deliberately waits out two `user-apps`
  // reconciles to prove the break is stable rather than racing drift correction.
  test.describe.configure({ retries: 0, timeout: 900_000 });

  test("a broken app degrades alone; the shared objects and the UI stay Ready", async ({ request }) => {
    commitBrokenApp();

    await expect.poll(() => readyOrAbsent("kustomization", `marketplace-${APP}`), {
      message: `marketplace-${APP} is applied and goes Ready=False`,
      timeout: 300_000,
      intervals: [10_000],
    }).toBe("False");

    // STABILITY, not a snapshot. `user-apps` reconciles every 1m; surviving ~2.5
    // intervals proves Flux is enforcing the broken state, not healing it. If this
    // assertion ever fails, the break mechanism has regressed to something Flux
    // overwrites — which is exactly the flake this test was rewritten to remove.
    await new Promise((resolve) => setTimeout(resolve, 150_000));
    expect(ready("kustomization", `marketplace-${APP}`)).toBe("False");

    // The whole point: nothing shared degraded with it.
    expect(ready("kustomization", "user-apps-source")).toBe("True");
    expect(ready("kustomization", "user-apps")).toBe("True");
    expect(ready("kustomization", "marketplace-ui")).toBe("True");

    // And the installer UI is still serving — the tool you need to remove it.
    // (That removal itself is covered by Tier 1's uninstall test and by
    // reconcile-lifecycle; asserting it here would mutate state those specs share.)
    expect((await request.get("/api/apps")).ok()).toBeTruthy();
    expect((await request.get("/api/installed")).ok()).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it against a fresh k3d cluster**

Run: `cd ui && npm run test:e2e:ui:cluster -- tests/cluster-level/broken-app-isolation.spec.ts`
Expected: 1 passed. Before Task 8 this test fails on
`expect(ready("kustomization","user-apps")).toBe("True")` — that assertion is
the regression guard.

- [ ] **Step 3: Repoint the cold-boot harness at the new gate**

In `support/cold-boot-repro.sh`, the PRE/POST-fix detection greps
`marketplace-ui`'s live `dependsOn` for `user-apps`. Change the matched name to
`user-apps-source`:

```sh
if echo "$DEPS" | grep -qw "user-apps-source"; then
```

Update the header comment and the log lines that name the gate object, e.g.:

```sh
#   • POST-FIX (dependsOn: user-apps-source) → GATE=HELD: marketplace-ui sits at
#       DependencyNotReady and NO pod is created. user-apps-source is Ready ⇔ a
#       selective healthCheck on GitRepository/user-apps-source passes, i.e. Flux
#       cloned a SEEDED repo. Unlike the old `user-apps` gate this cannot be held
#       down by a broken user app (issue #182).
```

The existing step that evicts the retained GitRepository artifact stays exactly
as it is — it is what actually makes the source NotReady, and it now drives the
gate object directly.

Then replace the reconcile target that forced the old gate to observe the
un-seeded state, so it reconciles `user-apps-source` as well as `user-apps`:

```sh
  info "6) force the gate to observe the un-seeded state NOW (no source artifact ⇒ NotReady)"
  flux_request_reconcile kustomization user-apps
  flux_request_reconcile kustomization user-apps-source
```

- [ ] **Step 4: Repair the Tier 2 diagnostics probe**

`run-tier2.sh`'s `dump_diagnostics()` reads the repo through the server pod using
`GOGS_URL` / `GOGS_USERNAME` / `GOGS_TOKEN` and fetches
`raw/master/kustomization.yaml`. **All three env vars are deleted by Task 7 and
that file no longer exists**, so the probe would silently produce nothing —
precisely when a Tier 2 failure needs it most. It is also the wrong tool now: the
pod has a git working copy, which is a more direct answer to "what does the repo
actually contain?".

Replace that `kubectl exec … node -e '…'` block with a git read (no auth needed —
it inspects the clone the server already maintains):

```sh
  if [ -n "$pod" ]; then
    {
      echo "== HEAD =="
      kubectl exec -n "$NS" "$pod" -c marketplace-ui -- \
        git -C /var/lib/user-apps/repo log --oneline -5 2>&1 || true
      echo "== tree =="
      kubectl exec -n "$NS" "$pod" -c marketplace-ui -- \
        git -C /var/lib/user-apps/repo ls-tree -r --name-only HEAD 2>&1 || true
      echo "== discovered remote =="
      kubectl get gitrepository user-apps-source -n flux-system \
        -o jsonpath='{.spec.url}{"\n"}{.status.conditions[*].message}{"\n"}' 2>&1 || true
    } > "$DIAG_DIR/user-apps-repo-state.txt" 2>&1 || true
  fi
```

An empty or missing working copy is itself the diagnosis (the server never reached
the repo), so a failing `git -C` here is useful output rather than a problem.

Also update the `dump_diagnostics` header comment, which currently describes "same
calls as GogsService: Basic-auth token bootstrap, then GET raw/master/kustomization.yaml".

- [ ] **Step 5: Verify the harness and the diagnostics**

Run: `bash -n ui/packages/e2e/support/cold-boot-repro.sh && bash -n ui/packages/e2e/support/run-tier2.sh && echo "syntax OK"`
Expected: `syntax OK`.

Run: `grep -n "GOGS_URL\|GOGS_TOKEN\|raw/master/kustomization.yaml" ui/packages/e2e/support/run-tier2.sh`
Expected: no output.

Run: `ui/packages/e2e/support/cold-boot-repro.sh` (against the dev cluster,
per the script's own kubeconfig handling)
Expected: `GATE=HELD` and a 200 install after the seed is released — the #180
guarantee still holds through the new gate.

- [ ] **Step 6: Commit**

```bash
git add ui/packages/e2e/tests/cluster-level/broken-app-isolation.spec.ts ui/packages/e2e/support/cold-boot-repro.sh ui/packages/e2e/support/run-tier2.sh
git commit -m "test(marketplace-ui): assert a broken app degrades alone; move the cold-boot gate (#182)"
```

---

### Task 13: Release — version bumps and docs

**Files:**
- Modify: `apps/marketplace-ui/metadata.yaml`, `apps/marketplace-ui/overlays/librepod/kustomization.yaml`, `infrastructure/system-apps/marketplace-ui.yaml`, `ui/package.json`
- Modify: `ui/CLAUDE.md`, `docs/user-guide.md`, `docs/DECISIONS_LOG.md`
- Modify: `.claude/skills/verify-app/SKILL.md`, `.claude/skills/verify-app/references/troubleshooting.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a publishable `0.6.0` and documentation that matches the code.

- [ ] **Step 1: Bump the version in all four places**

`0.5.3` → `0.6.0` in:
- `apps/marketplace-ui/metadata.yaml` → `spec.version`
- `apps/marketplace-ui/overlays/librepod/kustomization.yaml` → `newTag`
- `infrastructure/system-apps/marketplace-ui.yaml` → `ref.tag`
- `ui/package.json` → `version` (without this the image does not publish)

Run: `grep -rn "0\.6\.0" apps/marketplace-ui/metadata.yaml apps/marketplace-ui/overlays/librepod/kustomization.yaml infrastructure/system-apps/marketplace-ui.yaml ui/package.json | wc -l`
Expected: `4`.

**Do not** touch `catalog.yaml` or `apps/marketplace-ui/base/catalog.yaml` — CI
regenerates both.

- [ ] **Step 2: Update `ui/CLAUDE.md`**

Four sections are now wrong; rewrite them:

- **"No database — Git is the source of truth"**: "installed" is now
  `apps/<name>/` existing in the repo tree, not an entry in a root
  `kustomization.yaml`. Reads come from a shallow git working copy; unreachable
  git with a cached copy serves a **stale** list, and only a cold start with no
  working copy reports everything `not_installed`.
- **"Install flow"**: steps 4–5 collapse into one atomic commit; delete the
  "Pitfall 3" ordering rule and say why it no longer applies (atomicity comes
  from the commit). Uninstall now **deletes** the app's files.
- **"Gogs auth (GogsService)"**: replace with a "App-store repo (`UserAppsRepoService`)"
  section describing `GitClient` / `GitRemoteService` / `UserAppsRepoService`, the
  discovery-from-`GitRepository` seam, why the credential is mounted rather than
  read from `flux-system`, and the fact that the provider's contents API has no
  DELETE route (so git is not optional).
- **Configuration table**: drop `GOGS_URL`, `GOGS_USERNAME`, `GOGS_TOKEN`; add
  `USER_APPS_GIT_URL` (test seam — normally discovered), `USER_APPS_GIT_BRANCH`,
  `USER_APPS_GIT_USERNAME`, `USER_APPS_GIT_PASSWORD`,
  `USER_APPS_GIT_CREDENTIALS_DIR`, `USER_APPS_WORK_DIR`. State that the transport
  is `http(s)` **only** and that an `ssh://` remote is rejected at resolution —
  otherwise the next reader assumes both work and debugs the wrong thing.

Also update the Tier 1 gotcha that reads "**`GOGS_TOKEN` is the Gogs user's
*password***" to describe the git HTTP credential instead.

- [ ] **Step 2b: Update the `verify-app` skill**

The skill documents the install flow it walks a user through, and it is now not
merely stale — one of its steps is actively undone by `migrateLayout()`.

- `SKILL.md:187` "Update the root `kustomization.yaml` in the repo to include the
  new app" → committing `apps/<name>/` **is** the install; there is no root file.
  Left as-is, following the skill would add a root file that the next server boot
  deletes.
- `SKILL.md:292` "Remove from root kustomization.yaml" → delete the app directory
  and commit.
- `SKILL.md:159`'s repo-layout sketch → show `apps/<name>/` with no root file.
- `references/troubleshooting.md:129` "Root `kustomization.yaml` in user-apps repo
  doesn't reference the app directory" → replace with the real failure mode now:
  a malformed YAML file anywhere in the tree fails the whole-tree build (design
  F6), and `user-apps` reports it.
- `references/troubleshooting.md:109` "Authentication secret `user-apps-source-auth`
  expired or missing" → still the right Secret name after Task 8, but say what it
  is now: the HTTP basic credential Flux **and** the installer both use.

- [ ] **Step 3: Fix `docs/user-guide.md` §3.3**

The manual flow is stale and would now be wrong in a new way. Change:
- `mkdir -p vaultwarden` → `mkdir -p apps/vaultwarden`
- `git push origin main` → `git push origin master`
- Add a note: there is no root `kustomization.yaml` to edit — Flux generates one
  from the tree, so committing `apps/<name>/` is the whole install. To uninstall,
  delete the directory and commit.

- [ ] **Step 4: Append the decision rows**

`docs/DECISIONS_LOG.md` is append-only.

**Row 7 — the http(s) transport switch — has already landed** (committed ahead of
this task, since the decision was taken at design-review time and the log records
decisions rather than shipped code). Do not re-add it. What remains is the
layer-split/git-write-layer row, appended as **row 8**, and marking row 6
superseded.

Prefix row 6's Decision cell with `**Superseded by row 8.**` and leave the rest of
its text intact — row 8, not row 7, is what moves #180's gate off `user-apps`.
(The log numbers *decisions*, not issues: pointing row 6 at "#182" would send a
reader to GitHub instead of to a row in the same table.) Then append:

```
| 8 | 2026-08-22 | marketplace-ui | Split the app-store wiring into three Flux layers with distinct meanings — `user-apps-source` (Ready ⇔ a selective healthCheck on GitRepository/user-apps-source, i.e. the git source is seeded), `user-apps` (`wait: false`, apply-only), `marketplace-<app>` (`wait: true`, that app's health) — gate `marketplace-ui` on the first; drop the shared root `kustomization.yaml` in favour of Flux's auto-generated one; and perform every repo mutation with a generic git client instead of the provider's REST API (issue #182) | `user-apps` with `wait: true` health-checked every per-app Kustomization it applied, so ONE unhealthy app turned the shared object `Ready=False` and, via #180's gate, could block re-applying the installer UI — the tool needed to remove it. Apps already had their own Kustomizations, so the fix was to dissolve the aggregate, not to redesign installs. The root file was also a shared mutable allow-list serialising every install; removing it makes install/uninstall one atomic commit each and retires the "Pitfall 3" write-ordering rule. The git client is required, not preferred: this Gogs release has NO DELETE route on its contents API (live-probed), so uninstall could never delete an app's files over REST — and git is what makes the repo pluggable to GitHub or GitLab. Note this buys HEALTH isolation, not build isolation: with the whole tree as the build input, one malformed YAML file still fails the build for every app. |
```

- [ ] **Step 5: Full verification sweep**

Run: `cd ui && npm test --workspace=packages/server && npm run test:client`
Expected: all pass.

Run: `cd ui && npm run build:client && npm run build`
Expected: both succeed.

Run: `cd ui && npm run test:e2e:ui`
Expected: Tier 1 green.

Run: `kustomize build apps/marketplace-ui/overlays/librepod > /dev/null && kustomize build infrastructure/user-apps-source > /dev/null && kustomize build infrastructure/system-apps > /dev/null && echo "manifests OK"`
Expected: `manifests OK`.

Run: `git grep -n "GOGS_URL\|GogsService\|addToRootKustomization\|ensureWritableToken" -- ':!docs' ':!*.md'`
Expected: no output.

Run: `git grep -n "GIT_SSH_COMMAND\|openssh-client\|ssh-keyscan" -- ui/`
Expected: no output — no unexercised transport shipped in the app or its image.

Run: `git grep -n "user-apps-ssh-key" -- apps/ infrastructure/`
Expected: hits **only** in `infrastructure/user-apps-source/bootstrap-ssh-key/`
(the Job still provisions it) — and none under `apps/marketplace-ui/`, which must
mount `user-apps-git-auth` instead.

Run: `grep -n "cluster.local:22" infrastructure/user-apps-source/gitrepository.yaml`
Expected: no output — the GitRepository no longer points at the ssh transport.
(Do **not** widen this grep to all of `infrastructure/`: the bootstrap Job uses a
dotless in-cluster URL and works today, which is one half of design F13's open
question. Changing it is out of scope here.)

- [ ] **Step 6: Commit**

```bash
git add apps/marketplace-ui/metadata.yaml apps/marketplace-ui/overlays/librepod/kustomization.yaml infrastructure/system-apps/marketplace-ui.yaml ui/package.json ui/CLAUDE.md docs/user-guide.md docs/DECISIONS_LOG.md .claude/skills/verify-app
git commit -m "release(marketplace-ui): 0.6.0 — per-app isolation + git write layer (#182)"
```

---

## Post-merge verification (dev cluster)

Not a task — do this after the image publishes, because Tier 2 tests the
published `:latest` and the `ref.tag` pin is what actually moves a cluster.

1. `flux get kustomizations -n flux-system` — `user-apps-source`, `user-apps`,
   `marketplace-ui` all `Ready=True`; `user-apps` shows no `Healthy` condition
   (it no longer health-checks). Also confirm `GitRepository/user-apps-source` is
   Ready on the **http** URL (`kubectl get gitrepository user-apps-source -n
   flux-system -o jsonpath='{.spec.url}'`) — this is the first live proof of the
   transport flip, and it is the same URL the installer will discover.
2. Confirm the credential wiring end-to-end: `Secret/user-apps-git-auth` exists in
   `marketplace-ui` **with data** (Reflector filled the placeholder), and the old
   `gogs-auth` Secret is gone (pruned). Then delete `user-apps-git-auth` once and
   check the pod stays `Running` and `/api/health` still answers — that is the
   whole point of the placeholder, and it is worth proving once by hand since no
   automated tier covers a live Reflector.
3. Confirm the repo migrated: its tree has no root `kustomization.yaml` and no
   orphaned app directories.
4. Install and uninstall one app through the UI; confirm the app's directory
   appears and then disappears, each in a single commit. This is also the live
   proof that the default-port credential entry is right — an auth failure here
   means the `URL.host` bug is back (Task 2), and Tier 1 would not have caught it.
5. Run `ui/packages/e2e/support/cold-boot-repro.sh` — expect `GATE=HELD` plus a
   200 install after release.
6. Break one app and confirm only its own Kustomization degrades. Break it the way
   Task 12 does — **commit** a bad tag — not with `kubectl patch`, which Flux
   reverts within a minute (design F16).
7. Answer design F13 on a device: `kubectl exec -n marketplace-ui
   deploy/marketplace-ui -c marketplace-ui -- cat /etc/resolv.conf`, and record
   whether `search` carries the app zone.
