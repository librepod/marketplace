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
