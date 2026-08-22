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
