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
