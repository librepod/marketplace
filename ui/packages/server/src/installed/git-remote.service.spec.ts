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
