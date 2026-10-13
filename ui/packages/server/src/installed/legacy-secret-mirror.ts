import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as yaml from 'js-yaml';
import { OpenBaoClient } from './openbao.client';
import { UserAppsRepoService } from './user-apps-repo.service';

const HOURLY_MS = 60 * 60 * 1000;

/**
 * Apps installed BEFORE the settings moved to OpenBao carry their real secret
 * values only in the Gogs-committed `apps/<name>/secret.yaml`. A migrated app's
 * ExternalSecret reads `apps/<name>` from OpenBao, so those values must exist
 * there too — this mirror copies them over, merge-if-absent: a key OpenBao
 * already has (e.g. written by a later install) always wins.
 *
 * Runs at boot, hourly, and — the only load-bearing invocation — synchronously
 * during uninstall, BEFORE the Gogs files are deleted: after that the values
 * exist nowhere, and a reinstall on surviving NFS data must reuse them.
 */
export function mergeLegacyIntoStored(
  fileContents: string,
  stored: Record<string, string> | null,
): Record<string, string> | null {
  const parsed = yaml.load(fileContents) as { stringData?: Record<string, unknown> } | null;
  const legacy =
    parsed && typeof parsed === 'object' ? (parsed.stringData ?? {}) : {};

  const merged = { ...(stored ?? {}) };
  let added = false;
  for (const [key, raw] of Object.entries(legacy)) {
    // Anything but a scalar is malformed stringData that k8s would reject too.
    let value: string | null = null;
    if (typeof raw === 'string') value = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') value = String(raw);
    // Empty and still-literal ${VAR} values were never real; skipping them here
    // (before the merge decision) keeps them from blocking the null result.
    if (value === null || value === '' || value.includes('${')) continue;
    if (stored && key in stored) continue;
    merged[key] = value;
    added = true;
  }
  return added ? merged : null;
}

@Injectable()
export class LegacySecretMirror implements OnModuleInit {
  private readonly logger = new Logger(LegacySecretMirror.name);

  constructor(
    private readonly repo: UserAppsRepoService,
    private readonly openBao: OpenBaoClient,
  ) {}

  /** Fire-and-forget: the boot must not wait on (or die with) the mirror. */
  onModuleInit(): void {
    void this.mirrorOnce().catch((err: unknown) =>
      this.logger.warn(`boot-time legacy secret mirror failed: ${(err as Error).message}`),
    );
    setInterval(() => {
      void this.mirrorOnce().catch((err: unknown) =>
        this.logger.warn(`hourly legacy secret mirror failed: ${(err as Error).message}`),
      );
    }, HOURLY_MS).unref();
  }

  /**
   * Mirror every installed app that still has a secret.yaml. Per-app failures
   * are logged and skipped — one bad file must not stop the rest.
   */
  async mirrorOnce(): Promise<{ apps: number; keys: number }> {
    let apps = 0;
    let keys = 0;
    for (const name of await this.repo.listInstalledApps()) {
      try {
        const wrote = await this.snapshotApp(name);
        if (wrote > 0) {
          apps++;
          keys += wrote;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `legacy secret mirror failed for ${name}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return { apps, keys };
  }

  /** Mirror logic scoped to one app. Returns the number of keys written. */
  async snapshotApp(app: string): Promise<number> {
    const contents = await this.repo.readAppFile(app, 'secret.yaml');
    if (contents === null) return 0;
    const stored = await this.openBao.readAppSettings(app);
    const merged = mergeLegacyIntoStored(contents, stored);
    if (merged === null) return 0;
    const keys = Object.keys(merged).length - Object.keys(stored ?? {}).length;
    await this.openBao.writeAppSettings(app, merged);
    return keys;
  }
}
