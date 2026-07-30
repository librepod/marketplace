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
  private readonly logger = new Logger(CatalogService.name);
  private apps: CatalogApp[] = [];
  private watcher: fs.FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    this.loadCatalog();
    this.watchCatalog();
  }

  onModuleDestroy(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
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
      this.logger.log(
        `Loaded ${this.apps.length} user-facing apps from catalog`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to load catalog: ${message}`);
      this.apps = [];
    }
  }

  private watchCatalog(): void {
    const catalogPath = this.catalogPath;
    const dir = path.dirname(catalogPath);
    const filename = path.basename(catalogPath);

    try {
      this.watcher = fs.watch(dir, (eventType, changedFile) => {
        if (changedFile !== filename) return;
        // Debounce: editors and OCI extractors may fire multiple events per save
        if (this.reloadTimer) clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.logger.log('Catalog file changed, reloading...');
          this.loadCatalog();
        }, 300);
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
