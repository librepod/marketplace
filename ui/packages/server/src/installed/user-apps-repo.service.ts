import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readdir, mkdir, access, rm, writeFile, readFile } from 'node:fs/promises';
import { Mutex } from 'async-mutex';
import * as yaml from 'js-yaml';
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
 *
 * There is exactly ONE working copy, so every operation that touches it is
 * serialized on `mutex` — including reads. The client polls /api/apps every few
 * seconds while an install runs, and an unsynchronized read is not harmless: its
 * `fetch` collides with the writer's over `.git/shallow.lock`, and its
 * `reset --hard` + `clean -fdx` landing between a write's mutate() and stageAll()
 * deletes the new files, so the commit is empty and the install is silently lost.
 *
 * The mutex is NOT reentrant, and the call graph is nested (writeApp →
 * ensureMigrated → migrateLayout → commitAndPush → syncWorkingCopy) while
 * migrateLayout is also a public entry point. So the lock is taken at the public
 * entry points ONLY; each delegates to an unlocked `*Locked` inner method, and
 * inner methods only ever call other inner methods.
 */
@Injectable()
export class UserAppsRepoService implements OnModuleInit {
  private readonly logger = new Logger(UserAppsRepoService.name);
  private readonly mutex = new Mutex();
  private lastFetchMs = 0;
  private migrated = false;

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

  /**
   * Force the next read to re-fetch. Used by tests and after every write.
   * Touches a counter, not the working copy, so it needs no lock.
   */
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
    return this.mutex.runExclusive(() => this.listInstalledAppsLocked());
  }

  private async listInstalledAppsLocked(): Promise<string[]> {
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

  /**
   * Apply an idempotent mutation to the repo as exactly one commit.
   *
   * `mutate` must be idempotent because it is replayed on a push retry: a
   * non-fast-forward rejection means someone else committed, so we hard-reset to
   * the new origin tip and re-apply. Resetting BEFORE re-applying is what keeps
   * the other writer's commit intact.
   *
   * `message` may be a callback, evaluated AFTER mutate on each attempt — for
   * mutations that only discover what they changed while running (see
   * migrateLayout naming the orphans it dropped).
   */
  private async commitAndPush(
    message: string | (() => string),
    mutate: () => Promise<void>,
  ): Promise<void> {
    const remote = await this.remote.resolve();
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      await this.syncWorkingCopy(true);
      await mutate();
      await this.git.stageAll(this.repoDir);
      const committed = await this.git.commit(
        this.repoDir,
        typeof message === 'function' ? message() : message,
      );
      if (!committed) return; // already in the desired state
      // Only a real commit moves the tree away from what the last fetch saw; a
      // no-op must not force the next read to re-fetch. (The push retry below
      // re-syncs with required=true, which ignores freshness either way.)
      this.invalidateFreshness();

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
    if (!this.migrated) await this.migrateLayoutLocked();
  }

  async migrateLayout(): Promise<void> {
    return this.mutex.runExclusive(() => this.migrateLayoutLocked());
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
  private async migrateLayoutLocked(): Promise<void> {
    // Filled by the mutation, read by the message callback: the deletions are
    // only discovered while migrating, and `git log` has to explain them to
    // whoever finds an app directory missing later.
    let dropped: string[] = [];

    await this.commitAndPush(
      () =>
        dropped.length === 0
          ? 'chore: migrate to per-app layout (#182)'
          : [
              'chore: migrate to per-app layout (#182)',
              '',
              'Dropped orphaned app directories — present in the tree but absent',
              'from the old root kustomization.yaml allow-list, so not deployed,',
              'and they would have sprung to life once that file was removed:',
              ...dropped.map((name) => `  - apps/${name}`),
            ].join('\n'),
      async () => {
        dropped = []; // a push retry replays this; the report must not accumulate
        const rootFile = join(this.repoDir, 'kustomization.yaml');
        let raw: string;
        try {
          raw = await readFile(rootFile, 'utf8');
        } catch {
          return; // already migrated
        }

        const parsed = yaml.load(raw) as { resources?: string[] } | null;
        // Hand-written entries take several equivalent shapes — `apps/foo`,
        // `./apps/foo`, a trailing slash, stray whitespace. Any shape we fail
        // to normalize looks like an orphan and gets DELETED, so be generous.
        const listed = new Set(
          (parsed?.resources ?? []).map((r) =>
            String(r)
              .trim()
              .replace(/^\.\//, '')
              .replace(/^apps\//, '')
              .replace(/\/+$/, ''),
          ),
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
            dropped.push(name);
          }
        }
        await this.git.removePath(this.repoDir, 'kustomization.yaml');
      },
    );
    this.migrated = true;
  }

  async writeApp(name: string, files: Record<string, string>): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.ensureMigrated();
      await this.commitAndPush(`install ${name}`, async () => {
        const dir = join(this.repoDir, 'apps', name);
        await mkdir(dir, { recursive: true });
        for (const [file, content] of Object.entries(files)) {
          await writeFile(join(dir, file), content);
        }
      });
    });
  }

  async removeApp(name: string): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.ensureMigrated();
      await this.commitAndPush(`uninstall ${name}`, async () => {
        await this.git.removePath(this.repoDir, `apps/${name}`);
      });
    });
  }
}
