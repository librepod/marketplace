import { describe, it, expect, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConfigController } from './config.controller';

describe('ConfigController', () => {
  let module: TestingModule;

  afterEach(async () => {
    if (module) await module.close();
  });

  it('returns the configured BASE_DOMAIN', async () => {
    module = await Test.createTestingModule({
      controllers: [ConfigController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: string) =>
              key === 'BASE_DOMAIN' ? 'apps.example.test' : def,
          },
        },
      ],
    }).compile();

    const controller = module.get<ConfigController>(ConfigController);
    expect(controller.findAll()).toEqual({ baseDomain: 'apps.example.test' });
  });

  it('defaults to libre.pod when BASE_DOMAIN is unset', async () => {
    module = await Test.createTestingModule({
      controllers: [ConfigController],
      providers: [
        {
          provide: ConfigService,
          useValue: { get: (_key: string, def?: string) => def },
        },
      ],
    }).compile();

    const controller = module.get<ConfigController>(ConfigController);
    expect(controller.findAll()).toEqual({ baseDomain: 'libre.pod' });
  });
});
