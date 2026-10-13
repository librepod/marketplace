import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Controller, Post, Body } from '@nestjs/common';
import { JSON_BODY_LIMIT_BYTES } from '../src/installed/install-settings';

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: { value: string }) {
    return { length: body.value.length };
  }
}

// main.ts raises the JSON body limit above Nest's 100 KB default; this proves the same
// call takes effect on Nest's Express adapter (it must replace the default parser).
describe('JSON body limit (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts an escape-heavy body well over 100 KB', async () => {
    const value = '"'.repeat(150 * 1024); // 300 KiB once JSON-escaped
    const res = await request(app.getHttpServer()).post('/echo').send({ value });
    expect(res.status).toBe(201);
    expect(res.body.length).toBe(value.length);
  });

  it('still rejects a body over the limit', async () => {
    const value = 'x'.repeat(JSON_BODY_LIMIT_BYTES + 1);
    const res = await request(app.getHttpServer()).post('/echo').send({ value });
    expect(res.status).toBe(413);
  });
});
