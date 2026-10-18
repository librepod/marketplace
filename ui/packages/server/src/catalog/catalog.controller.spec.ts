import { describe, it, expect, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { InstalledService } from '../installed/installed.service';

describe('CatalogController', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('GET :name/settings is never cached: the body carries plaintext tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CatalogController],
      providers: [
        { provide: CatalogService, useValue: {} },
        { provide: InstalledService, useValue: { getSettings: async () => ({ settings: { TOKEN: 't' }, custom: [] }) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const res = await request(app.getHttpServer()).get('/apps/renovate/settings').expect(200);

    expect(res.body).toEqual({ settings: { TOKEN: 't' }, custom: [] });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
