import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { CatalogApp, CatalogFile } from './catalog.types';

@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
  private static readonly RELOAD_DEBOUNCE_MS = 300;
  private static readonly RELOAD_RETRY_MS = 1_000;

  private readonly logger = new Logger(CatalogService.name);
  private apps: CatalogApp[] = [];
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedOnce = false;
  private reloadFailed = false;
  private lastGoodAt: Date | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.loadCatalog();
    this.watchCatalog();
  }

  onModuleDestroy(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.watcher?.close();
  }

  private get catalogPath(): string {
    return this.configService.get<string>(
      'CATALOG_PATH',
      path.resolve(process.cwd(), '../../../catalog.yaml'),
    );
  }

  private loadCatalog(): void {
    try {
      const content = fs.readFileSync(this.catalogPath, 'utf-8');
      const raw = yaml.load(content);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid catalog.yaml: expected a YAML mapping at root');
      }
      const catalog = raw as CatalogFile;
      this.apps = (catalog.apps ?? []).filter(
        (app) => app.category !== 'Infrastructure',
      );
      this.loadedOnce = true;
      this.reloadFailed = false;
      this.lastGoodAt = new Date();
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.logger.log(
        `Loaded ${this.apps.length} user-facing apps from catalog`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!this.loadedOnce) {
        const hint =
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? ' — generate it with `bash ./scripts/generate-catalog.sh` (see CLAUDE.md); on a cluster it is mounted from the marketplace-catalog ConfigMap'
            : '';
        this.logger.error(`Failed to load catalog: ${message}${hint}`);
        return;
      }
      if (!this.reloadFailed) {
        // The mounted ConfigMap is updated in place (stable name); the kubelet
        // symlink swap can briefly make the file unreadable mid-rename. Retry
        // once before declaring the catalog stale — the transient window is
        // milliseconds, a permanent failure will not recover on the retry.
        this.reloadFailed = true;
        this.logger.warn(
          `Failed to reload catalog (${message}); retrying in ${CatalogService.RELOAD_RETRY_MS}ms`,
        );
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.loadCatalog();
        }, CatalogService.RELOAD_RETRY_MS);
      } else {
        // Keep serving the last-good list rather than blanking the catalog,
        // but escalate so staleness is visible in logs.
        this.logger.error(
          `Catalog reload still failing; serving last-good list (${this.apps.length} apps, last successful load ${
            this.lastGoodAt?.toISOString() ?? 'unknown'
          }): ${message}`,
        );
      }
    }
  }

  private watchCatalog(): void {
    const dir = path.dirname(this.catalogPath);

    try {
      // Watch the directory and reload on ANY event, without filtering by
      // filename: kubelet updates ConfigMap volumes with its atomic writer —
      // it renames a `..data_tmp` symlink over `..data`, while the leaf
      // `catalog.yaml` is a stable symlink that is never recreated. Events
      // therefore arrive for `..data`/`..<timestamp>`, never for
      // `catalog.yaml` itself, and a filename filter would silently drop
      // every real in-cluster update.
      this.watcher = fs.watch(dir, () => {
        // Debounce: the atomic swap fires several events per update, and
        // editors/OCI extractors may fire multiple events per save.
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = null;
          this.logger.log('Catalog change detected, reloading...');
          this.reloadFailed = false;
          this.loadCatalog();
        }, CatalogService.RELOAD_DEBOUNCE_MS);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Could not watch catalog directory: ${message}`);
    }
  }

  findAll(): CatalogApp[] {
    return this.apps;
  }

  findOne(name: string): CatalogApp | undefined {
    return this.apps.find((app) => app.name === name);
  }
}
