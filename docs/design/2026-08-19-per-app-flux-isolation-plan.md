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
- **Do not disable SSH host-key checking** anywhere. The bootstrap Job provides `known_hosts`; if it is missing, fail loudly.
- **Never put git credentials in a remote URL** — they leak into `git remote -v`, the reflog, and error messages. Use `GIT_SSH_COMMAND` (ssh) or a `0600` credentials file via `credential.helper` (http/https).
- **Use the discovered URL verbatim.** Do *not* "helpfully" append a trailing dot to the host for FQDN resolution: `known_hosts` is keyed to the exact hostname `ssh-keyscan` used, so a rewritten host fails host-key verification. Flux clones this same URL successfully from a pod today, which is the evidence that resolution works.
- **Nothing may throw out of `onModuleInit` when git is unreachable.** That is the #176 failure mode: a one-shot bootstrap that fails leaves the container broken for its whole lifetime. Log and self-heal lazily on the next call.

---

## File Structure

**New (server):**
| File | Responsibility |
|---|---|
| `ui/packages/server/src/installed/git-client.ts` | Mechanical git operations in a working directory. No knowledge of apps or Kubernetes. |
| `ui/packages/server/src/installed/git-remote.service.ts` | Resolves *where* the repo is and *how* to authenticate: env override → `GitRepository/user-apps-source`; credential materialisation. No knowledge of apps or git commands. |
| `ui/packages/server/src/installed/user-apps-repo.service.ts` | App-level semantics: list/write/remove `apps/<name>/`, and the one-time layout migration. Uses the two above. |

**Deleted (server):** `gogs.service.ts`, `gogs.service.spec.ts`.

**Modified (server):** `installed.service.ts`, `installed.service.spec.ts`, `installed.module.ts`, `rbac-manifest.spec.ts`.

**Modified (manifests):** `apps/marketplace-ui/base/{serviceaccount,deployment,configmap}.yaml`, `apps/marketplace-ui/overlays/librepod/kustomization.yaml`, `apps/marketplace-ui/metadata.yaml`, `infrastructure/user-apps-source/user-apps.yaml`, `infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`, `infrastructure/system-apps/marketplace-ui.yaml`, `clusters/{librepod,librepod-dev,librepod-k3d}/user-apps-source.yaml`, `ui/Dockerfile`, `ui/package.json`.

**Modified (tests):** `ui/packages/e2e/projects/tier1.config.ts`, `ui/packages/e2e/support/gogs/seed.sh`, `ui/packages/e2e/support/cold-boot-repro.sh`, plus new specs under `ui/packages/e2e/tests/`.

**Modified (docs):** `ui/CLAUDE.md`, `docs/user-guide.md`, `docs/DECISIONS_LOG.md`.

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

/** A bare repo with one commit on `master`, to act as the "remote". */
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

    await git.clone(origin, work, 'master', NO_AUTH);
    expect(await readFile(join(work, 'README.md'), 'utf8')).toContain('user apps');

    await mkdir(join(work, 'apps', 'demo'), { recursive: true });
    await writeFile(join(work, 'apps', 'demo', 'release.yaml'), 'kind: Kustomization\n');
    await git.stageAll(work);
    expect(await git.commit(work, 'install demo')).toBe(true);
    await git.push(work, 'master', NO_AUTH);

    // A second, independent clone must observe the pushed commit.
    const verify = join(root, 'verify');
    await git.clone(origin, verify, 'master', NO_AUTH);
    expect(await readFile(join(verify, 'apps/demo/release.yaml'), 'utf8')).toContain('Kustomization');
  });

  it('commit() returns false when the tree is clean, so callers can stay idempotent', async () => {
    const origin = await makeOriginWithSeed(root);
    const work = join(root, 'work');
    await git.clone(origin, work, 'master', NO_AUTH);

    await git.stageAll(work);
    expect(await git.commit(work, 'no-op')).toBe(false);
  });

  it('removePath deletes a directory from the index and the worktree', async () => {
    const origin = await makeOriginWithSeed(root);
    const work = join(root, 'work');
    await git.clone(origin, work, 'master', NO_AUTH);
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
    await git.clone(origin, work, 'master', NO_AUTH);

    await writeFile(join(work, 'README.md'), 'locally corrupted\n');
    await writeFile(join(work, 'stray.yaml'), 'kind: Stray\n');
    await git.fetchAndReset(work, 'master', NO_AUTH);

    expect(await readFile(join(work, 'README.md'), 'utf8')).toContain('user apps');
    const { stdout } = await git.run(work, ['status', '--porcelain']);
    expect(stdout.trim()).toBe(''); // untracked stray removed too
  });

  it('surfaces git failures as errors carrying stderr', async () => {
    await expect(
      git.clone(join(root, 'does-not-exist.git'), join(root, 'work'), 'master', NO_AUTH),
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
    await this.run(process.cwd(), [
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
Expected: PASS — 5 tests.

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
- Consumes: `GitAuth` from Task 1.
- Produces:
  ```ts
  export interface GitRemote { url: string; branch: string; auth: GitAuth }
  export class GitRemoteService {
    constructor(config: ConfigService)
    resolve(): Promise<GitRemote>   // cached after first success
  }
  ```

Behaviour to implement:
- URL/branch from `USER_APPS_GIT_URL` / `USER_APPS_GIT_BRANCH` (default branch `master`) when set; otherwise `GET gitrepositories/user-apps-source` in `flux-system` → `spec.url`, `spec.ref.branch ?? 'master'`.
- Credential directory from `USER_APPS_GIT_CREDENTIALS_DIR` (default `/etc/user-apps-git`).
- `ssh://` → requires `identity` **and** `known_hosts`; the identity is **copied to a private `0600` path** because Kubernetes Secret volumes mount world-readable and `ssh` refuses such a key (`UNPROTECTED PRIVATE KEY FILE`).
- `http(s)://` → `USER_APPS_GIT_USERNAME`/`USER_APPS_GIT_PASSWORD`, else files `username`/`password`; written to a `0600` `.git-credentials` consumed via `credential.helper=store`.

- [ ] **Step 1: Write the failing test**

Create `ui/packages/server/src/installed/git-remote.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { GitRemoteService } from './git-remote.service';

function configOf(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
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
    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'http://127.0.0.1:43000/flux/user-apps.git',
      USER_APPS_GIT_BRANCH: 'master',
      USER_APPS_GIT_USERNAME: 'flux',
      USER_APPS_GIT_PASSWORD: 'pass@w0rd',
      USER_APPS_GIT_CREDENTIALS_DIR: join(root, 'creds'),
      USER_APPS_WORK_DIR: join(root, 'work'),
    }));
    const k8s = vi.spyOn(svc as never, 'readGitRepository');

    const remote = await svc.resolve();

    expect(k8s).not.toHaveBeenCalled();
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
    }));

    const remote = await svc.resolve();
    const file = /--file=(\S+)/.exec(remote.auth.configArgs.join(' '))![1];

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // URL-encoded so a password containing / or @ cannot corrupt the entry.
    expect(await readFile(file, 'utf8')).toContain('https://flux:p%40ss%2Fword@git.example.com');
  });

  it('copies the ssh identity to a 0600 path (Secret volumes mount world-readable)', async () => {
    const creds = join(root, 'creds');
    await mkdir(creds, { recursive: true });
    await writeFile(join(creds, 'identity'), 'PRIVATE KEY\n', { mode: 0o444 });
    await writeFile(join(creds, 'known_hosts'), 'gogs ssh-ed25519 AAAA\n', { mode: 0o444 });

    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'ssh://git@gogs.gogs.svc.cluster.local:22/flux/user-apps.git',
      USER_APPS_GIT_CREDENTIALS_DIR: creds,
      USER_APPS_WORK_DIR: join(root, 'work'),
    }));

    const remote = await svc.resolve();
    const cmd = remote.auth.env.GIT_SSH_COMMAND!;
    const identity = /-i (\S+)/.exec(cmd)![1];

    expect(identity).not.toBe(join(creds, 'identity'));   // a private copy
    expect((await stat(identity)).mode & 0o777).toBe(0o600);
    expect(cmd).toContain('UserKnownHostsFile=');
    expect(cmd).toContain('BatchMode=yes');
    expect(cmd).not.toContain('StrictHostKeyChecking=no'); // never disable this
  });

  it('fails loudly when an ssh remote has no known_hosts', async () => {
    const creds = join(root, 'creds');
    await mkdir(creds, { recursive: true });
    await writeFile(join(creds, 'identity'), 'PRIVATE KEY\n');

    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_URL: 'ssh://git@gogs/flux/user-apps.git',
      USER_APPS_GIT_CREDENTIALS_DIR: creds,
      USER_APPS_WORK_DIR: join(root, 'work'),
    }));

    await expect(svc.resolve()).rejects.toThrow(/known_hosts/);
  });

  it('discovers url and branch from GitRepository/user-apps-source when no override is set', async () => {
    const svc = new GitRemoteService(configOf({
      USER_APPS_GIT_CREDENTIALS_DIR: join(root, 'creds'),
      USER_APPS_WORK_DIR: join(root, 'work'),
    }));
    vi.spyOn(svc as never, 'readGitRepository').mockResolvedValue({
      spec: { url: 'ssh://git@example/flux/user-apps.git', ref: { branch: 'main' } },
    } as never);
    // ssh creds present so resolution can complete
    const creds = join(root, 'creds');
    await mkdir(creds, { recursive: true });
    await writeFile(join(creds, 'identity'), 'K\n');
    await writeFile(join(creds, 'known_hosts'), 'h k v\n');

    const remote = await svc.resolve();

    expect(remote.url).toBe('ssh://git@example/flux/user-apps.git');
    expect(remote.branch).toBe('main');
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
import { KubeConfig, CustomObjectsApi } from '@kubernetes/client-node';
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
 * reconciling. Repointing that object at GitHub/GitLab needs no code change.
 * We deliberately do NOT read the GitRepository's secretRef: its name is
 * dynamic, so RBAC could not scope it and the service would need `get secrets`
 * across all of flux-system. The credential is mounted instead.
 */
@Injectable()
export class GitRemoteService {
  private readonly logger = new Logger(GitRemoteService.name);
  private cached?: GitRemote;

  constructor(private readonly config: ConfigService) {}

  private get credentialsDir(): string {
    return this.config.get<string>('USER_APPS_GIT_CREDENTIALS_DIR', '/etc/user-apps-git');
  }

  private get workDir(): string {
    return this.config.get<string>('USER_APPS_WORK_DIR', '/var/lib/user-apps');
  }

  async resolve(): Promise<GitRemote> {
    if (this.cached) return this.cached;

    const { url, branch } = await this.resolveLocation();
    const auth = url.startsWith('ssh://')
      ? await this.sshAuth()
      : await this.httpAuth(url);

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

  /** Overridden in tests. Kept as its own method so it can be spied on. */
  private async readGitRepository(): Promise<GitRepositoryObject> {
    const kc = new KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
    else kc.loadFromDefault();
    const api = kc.makeApiClient(CustomObjectsApi);
    return (await api.getNamespacedCustomObject({
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

  private async sshAuth(): Promise<GitAuth> {
    const source = join(this.credentialsDir, 'identity');
    const knownHosts = join(this.credentialsDir, 'known_hosts');

    if (!(await this.exists(source))) {
      throw new Error(`ssh remote configured but no identity at ${source}`);
    }
    if (!(await this.exists(knownHosts))) {
      throw new Error(
        `ssh remote configured but no known_hosts at ${knownHosts} — refusing to ` +
          'disable host-key verification',
      );
    }

    // Kubernetes Secret volumes mount world-readable; ssh rejects such a key
    // ("UNPROTECTED PRIVATE KEY FILE"). Copy to a private 0600 path we own.
    const privateDir = join(this.workDir, '.ssh');
    await mkdir(privateDir, { recursive: true, mode: 0o700 });
    const identity = join(privateDir, 'identity');
    await writeFile(identity, await readFile(source), { mode: 0o600 });
    await chmod(identity, 0o600);

    return {
      env: {
        GIT_SSH_COMMAND:
          `ssh -i ${identity} -o IdentitiesOnly=yes -o BatchMode=yes ` +
          `-o UserKnownHostsFile=${knownHosts}`,
      },
      configArgs: [],
    };
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
    const parsed = new URL(url);
    const entry =
      `${parsed.protocol}//${encodeURIComponent(username)}:` +
      `${encodeURIComponent(password)}@${parsed.host}`;

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
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/server/src/installed/git-remote.service.ts ui/packages/server/src/installed/git-remote.service.spec.ts
git commit -m "feat(marketplace-ui): discover the user-apps remote from GitRepository, mount the credential (#182)"
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

/** Bare "remote" seeded with README.md + the given files (path → content). */
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
    resolve: async () => ({ url: origin, branch: 'master', auth: NO_AUTH }),
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
    await git.clone(origin, other, 'master', NO_AUTH);
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

In `installed.module.ts`, swap the import and provider list:

```ts
import { GitClient } from './git-client';
import { GitRemoteService } from './git-remote.service';
import { UserAppsRepoService } from './user-apps-repo.service';

// ...
  providers: [
    InstalledService,
    GitClient,
    GitRemoteService,
    UserAppsRepoService,
    FluxStatusService,
    SystemAppsService,
    LaunchUrlService,
  ],
```

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
            # The git identity Flux uses for this repo. Reflector already copies
            # user-apps-ssh-key into this namespace (see bootstrap-ssh-key.sh's
            # reflection-auto-namespaces). GitRemoteService copies the key to a
            # private 0600 path because Secret volumes mount world-readable and
            # ssh rejects such a key ("UNPROTECTED PRIVATE KEY FILE").
            - name: user-apps-git-credentials
              mountPath: /etc/user-apps-git
              readOnly: true
            # Working copy of the app-store repo (shallow clone) + the private
            # key/credential copies. Disposable: rebuilt on demand.
            - name: user-apps-work
              mountPath: /var/lib/user-apps
```

and in `volumes:`:

```yaml
        - name: user-apps-git-credentials
          secret:
            secretName: user-apps-ssh-key
        - name: user-apps-work
          emptyDir: {}
```

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

Removing the two `GOGS_*` env entries leaves `Secret/gogs-auth` unreferenced by
this Deployment. **Leave the Secret in place** — it is provisioned outside this
app and may have other consumers; deleting it is out of scope. Just note it in
the commit body so the loose end is visible to a reviewer.

- [ ] **Step 4: Verify**

Run: `cd ui && npm test --workspace=packages/server -- src/installed/rbac-manifest.spec.ts`
Expected: PASS.

Run: `kustomize build apps/marketplace-ui/overlays/librepod > /dev/null && echo OK`
Expected: `OK`.

Run: `kustomize build apps/marketplace-ui/overlays/librepod | grep -c "user-apps-git-credentials"`
Expected: `2` (the volume and the mount).

- [ ] **Step 5: Commit**

```bash
git add apps/marketplace-ui/base ui/packages/server/src/installed/rbac-manifest.spec.ts
git commit -m "feat(marketplace-ui): grant gitrepositories read, mount the git credential (#182)"
```

---

### Task 8: The three Flux layers

**Files:**
- Modify: `infrastructure/user-apps-source/user-apps.yaml`
- Modify: `clusters/librepod/user-apps-source.yaml`
- Modify: `clusters/librepod-dev/user-apps-source.yaml`
- Modify: `clusters/librepod-k3d/user-apps-source.yaml`
- Modify: `infrastructure/system-apps/marketplace-ui.yaml`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure manifest change).
- Produces: `user-apps-source` Ready ⇔ the git source is seeded — the gate Task 12's tests assert on.

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

- [ ] **Step 3: Repoint the marketplace-ui gate**

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

- [ ] **Step 4: Verify the manifests build and the gate is wired**

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

- [ ] **Step 5: Commit**

```bash
git add infrastructure/user-apps-source/user-apps.yaml clusters/*/user-apps-source.yaml infrastructure/system-apps/marketplace-ui.yaml
git commit -m "fix(marketplace-ui): isolate app health and gate the UI on a seeded source (#182)"
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
presence IS its declaration and one app's files cannot affect another's.

Managed by the LibrePod marketplace UI. FluxCD reconciles this repo into the
cluster.
MD
```

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

- [ ] **Step 2: Fix the false claim in the AUTH NOTE**

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

- [ ] **Step 3: Verify**

Run: `bash -n infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh && echo "syntax OK"`
Expected: `syntax OK`.

Run: `grep -c "cat > kustomization.yaml" infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`
Expected: `0`.

Run: `grep -n "git add" infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh`
Expected: `git add README.md` only.

Run: `kustomize build infrastructure/user-apps-source > /dev/null && echo OK`
Expected: `OK` (the script is embedded via configMapGenerator).

- [ ] **Step 4: Commit**

```bash
git add infrastructure/user-apps-source/bootstrap-ssh-key/bootstrap-ssh-key.sh
git commit -m "fix(user-apps-source): seed README only, never a root kustomization allow-list (#182)"
```

---

### Task 10: Ship `git` in the image

**Files:**
- Modify: `ui/Dockerfile`

**Interfaces:**
- Consumes: `GitClient` spawns `git`; `GitRemoteService` builds an `ssh` command.
- Produces: a runtime image where both binaries exist.

- [ ] **Step 1: Add the packages to the production stage**

In the `FROM node:22-alpine AS production` stage, immediately after `WORKDIR /app`:

```dockerfile
# The installer performs every app-store repo mutation over git (the provider's
# REST contents API has no DELETE route, so file removal is impossible there —
# see issue #182). openssh-client provides the ssh transport GIT_SSH_COMMAND
# drives; Flux's GitRepository for this repo is an ssh:// URL.
RUN apk add --no-cache git openssh-client
```

- [ ] **Step 2: Build and verify both binaries are present**

Run:
```bash
docker build -t marketplace-ui:182-check ui
docker run --rm --entrypoint sh marketplace-ui:182-check -c 'git --version && ssh -V'
```
Expected: a git version line and an OpenSSH version line, exit 0.

- [ ] **Step 3: Verify the server still boots in the image**

Run:
```bash
docker run --rm --entrypoint sh marketplace-ui:182-check -c 'test -f packages/server/dist/main.js && echo dist OK'
```
Expected: `dist OK`.

- [ ] **Step 4: Commit**

```bash
git add ui/Dockerfile
git commit -m "build(marketplace-ui): install git + openssh-client in the runtime image (#182)"
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
22), and it has no cluster — so the env override is mandatory, and the HTTP
credential path is what gets exercised.

- [ ] **Step 1: Point the server at the git remote**

In `tier1.config.ts`, replace the three `GOGS_*` entries in `webServer.env` with:

```ts
      // The installer performs repo mutations over git, not the provider API.
      // Tier 1 has no cluster, so GitRepository discovery is impossible — this
      // override is the documented test seam. HTTP (not ssh): the compose maps
      // only 43000 → gogs:3000, there is no port 22.
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
 * The break is deliberately at the app's own layer — a nonexistent OCI tag makes
 * OCIRepository/marketplace-<app> fail, so Kustomization/marketplace-<app> can
 * never become Ready. Its YAML stays valid, so `user-apps` still builds and
 * applies; only the app's own object degrades.
 */
function ready(kind: string, name: string): string {
  const out = execFileSync("kubectl", [
    "get", kind, name, "-n", "flux-system",
    "-o", 'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
  ], { encoding: "utf8" });
  return out.trim();
}

const BROKEN = "whoami";

test.describe("broken-app isolation (#182)", () => {
  test.describe.configure({ retries: 0, timeout: 600_000 });

  test("a broken app degrades alone; the shared objects and the UI stay Ready", async ({ request }) => {
    const install = await request.post(`/api/apps/${BROKEN}/install`);
    expect(install.ok()).toBeTruthy();

    // Break only this app: point its OCIRepository at a tag that does not exist.
    await expect.poll(
      () => {
        try {
          execFileSync("kubectl", [
            "get", "ocirepository", `marketplace-${BROKEN}`, "-n", "flux-system",
          ], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      },
      { message: "the app's OCIRepository appears", timeout: 180_000, intervals: [5_000] },
    ).toBe(true);

    execFileSync("kubectl", [
      "patch", "ocirepository", `marketplace-${BROKEN}`, "-n", "flux-system",
      "--type", "json",
      "-p", '[{"op":"replace","path":"/spec/ref/tag","value":"0.0.0-does-not-exist"}]',
    ]);

    await expect.poll(() => ready("kustomization", `marketplace-${BROKEN}`), {
      message: `marketplace-${BROKEN} goes Ready=False`,
      timeout: 300_000,
      intervals: [10_000],
    }).toBe("False");

    // The whole point: nothing shared degraded with it.
    expect(ready("kustomization", "user-apps-source")).toBe("True");
    expect(ready("kustomization", "marketplace-ui")).toBe("True");
    expect(ready("kustomization", "user-apps")).toBe("True");

    // And the installer UI is still usable — the tool you need to remove it.
    const apps = await request.get("/api/apps");
    expect(apps.ok()).toBeTruthy();

    const uninstall = await request.post(`/api/apps/${BROKEN}/uninstall`);
    expect(uninstall.ok()).toBeTruthy();
  });
});
```

**Pick an app the lifecycle specs do not touch.** Tier 2 is serial and shares one
cluster: `reconcile-lifecycle.spec.ts` installs an app via `pickApp(request)` and
later tests act on it, so deliberately breaking that same app would fail them.
`whoami` is the safe choice (a `Testing`-category fixture app), and
`LIBREPOD_E2E_APP` can pin the lifecycle spec to a different one if they ever
collide. This spec uninstalls what it broke, so the cluster is left clean.

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

- [ ] **Step 4: Verify the harness on the dev cluster**

Run: `bash -n ui/packages/e2e/support/cold-boot-repro.sh && echo "syntax OK"`
Expected: `syntax OK`.

Run: `ui/packages/e2e/support/cold-boot-repro.sh` (against the dev cluster,
per the script's own kubeconfig handling)
Expected: `GATE=HELD` and a 200 install after the seed is released — the #180
guarantee still holds through the new gate.

- [ ] **Step 5: Commit**

```bash
git add ui/packages/e2e/tests/cluster-level/broken-app-isolation.spec.ts ui/packages/e2e/support/cold-boot-repro.sh
git commit -m "test(marketplace-ui): assert a broken app degrades alone; move the cold-boot gate (#182)"
```

---

### Task 13: Release — version bumps and docs

**Files:**
- Modify: `apps/marketplace-ui/metadata.yaml`, `apps/marketplace-ui/overlays/librepod/kustomization.yaml`, `infrastructure/system-apps/marketplace-ui.yaml`, `ui/package.json`
- Modify: `ui/CLAUDE.md`, `docs/user-guide.md`, `docs/DECISIONS_LOG.md`

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
  `USER_APPS_GIT_CREDENTIALS_DIR`, `USER_APPS_WORK_DIR`.

Also update the Tier 1 gotcha that reads "**`GOGS_TOKEN` is the Gogs user's
*password***" to describe the git HTTP credential instead.

- [ ] **Step 3: Fix `docs/user-guide.md` §3.3**

The manual flow is stale and would now be wrong in a new way. Change:
- `mkdir -p vaultwarden` → `mkdir -p apps/vaultwarden`
- `git push origin main` → `git push origin master`
- Add a note: there is no root `kustomization.yaml` to edit — Flux generates one
  from the tree, so committing `apps/<name>/` is the whole install. To uninstall,
  delete the directory and commit.

- [ ] **Step 4: Append the decision rows**

`docs/DECISIONS_LOG.md` is append-only. Per its own convention, mark the old row
rather than rewriting it: prefix row 6's Decision cell with
`**Superseded by #182.**` and leave the rest of its text intact. Then append:

```
| 7 | 2026-08-19 | marketplace-ui | Split the app-store wiring into three Flux layers with distinct meanings — `user-apps-source` (Ready ⇔ a selective healthCheck on GitRepository/user-apps-source, i.e. the git source is seeded), `user-apps` (`wait: false`, apply-only), `marketplace-<app>` (`wait: true`, that app's health) — gate `marketplace-ui` on the first; drop the shared root `kustomization.yaml` in favour of Flux's auto-generated one; and perform every repo mutation with a generic git client instead of the provider's REST API (issue #182) | `user-apps` with `wait: true` health-checked every per-app Kustomization it applied, so ONE unhealthy app turned the shared object `Ready=False` and, via #180's gate, could block re-applying the installer UI — the tool needed to remove it. Apps already had their own Kustomizations, so the fix was to dissolve the aggregate, not to redesign installs. The root file was also a shared mutable allow-list serialising every install; removing it makes install/uninstall one atomic commit each and retires the "Pitfall 3" write-ordering rule. The git client is required, not preferred: this Gogs release has NO DELETE route on its contents API (live-probed), so uninstall could never delete an app's files over REST — and git is what makes the repo pluggable to GitHub or GitLab. |
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

- [ ] **Step 6: Commit**

```bash
git add apps/marketplace-ui/metadata.yaml apps/marketplace-ui/overlays/librepod/kustomization.yaml infrastructure/system-apps/marketplace-ui.yaml ui/package.json ui/CLAUDE.md docs/user-guide.md docs/DECISIONS_LOG.md
git commit -m "release(marketplace-ui): 0.6.0 — per-app isolation + git write layer (#182)"
```

---

## Post-merge verification (dev cluster)

Not a task — do this after the image publishes, because Tier 2 tests the
published `:latest` and the `ref.tag` pin is what actually moves a cluster.

1. `flux get kustomizations -n flux-system` — `user-apps-source`, `user-apps`,
   `marketplace-ui` all `Ready=True`; `user-apps` shows no `Healthy` condition
   (it no longer health-checks).
2. Confirm the repo migrated: its tree has no root `kustomization.yaml` and no
   orphaned app directories.
3. Install and uninstall one app through the UI; confirm the app's directory
   appears and then disappears, each in a single commit.
4. Run `ui/packages/e2e/support/cold-boot-repro.sh` — expect `GATE=HELD` plus a
   200 install after release.
5. Break one app (patch its OCIRepository tag) and confirm only its own
   Kustomization degrades.
