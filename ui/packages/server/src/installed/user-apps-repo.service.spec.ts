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

  it('discards a CORRUPT working copy so the next read re-clones', async () => {
    // The stale-read tolerance above must not extend to a working copy that is
    // no longer a usable git repo: that would wedge every future read on a tree
    // git itself cannot answer questions about. Distinguishing the two is the
    // whole reason sync failure is not an unconditional `rm -rf`.
    const origin = await seedOrigin(root, { 'apps/baikal/release.yaml': 'kind: K\n' });
    const svc = makeService(root, origin);
    await svc.listInstalledApps();

    await rm(join(root, 'work', 'repo', '.git', 'HEAD'), { force: true });
    svc.invalidateFreshness();

    expect(await svc.listInstalledApps()).toEqual(['baikal']); // re-cloned, not wedged
  });
});

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
