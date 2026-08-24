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
      // `args` only, never `auth.configArgs` — deliberate: it carries
      // `credential.helper=store --file=<path>`, which must stay out of logs and
      // API error bodies. Do not "helpfully" widen this to the full argv.
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
