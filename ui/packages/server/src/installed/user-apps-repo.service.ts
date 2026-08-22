import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readdir, mkdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitClient } from './git-client';
import { GitRemoteService, type GitRemote } from './git-remote.service';

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

  /** Can git still answer questions about this tree? See syncWorkingCopy. */
  private async isUsableWorkingCopy(): Promise<boolean> {
    try {
      await this.git.run(this.repoDir, ['rev-parse', '--verify', 'HEAD']);
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
    if (!required && fresh && (await this.hasWorkingCopy())) return true;

    try {
      if (await this.hasWorkingCopy()) {
        try {
          await this.git.fetchAndReset(this.repoDir, remote.branch, remote.auth);
          this.lastFetchMs = Date.now();
          return true;
        } catch (error: unknown) {
          // Two very different failures land here, and conflating them is a bug
          // in both directions. An UNREACHABLE REMOTE must leave the working
          // copy alone — a stale but true app list beats falsely reporting
          // nothing installed. A working copy git can no longer read is the
          // other case: keeping it would wedge every future read, so it is
          // discarded and re-cloned below.
          if (await this.isUsableWorkingCopy()) throw error;
          this.logger.warn('discarding an unreadable app-store working copy; re-cloning');
          await rm(this.repoDir, { recursive: true, force: true }).catch(() => undefined);
        }
      }

      await mkdir(this.workDir, { recursive: true });
      await rm(this.repoDir, { recursive: true, force: true });
      await this.git.clone(remote.url, this.repoDir, remote.branch, remote.auth);
      this.lastFetchMs = Date.now();
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
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
