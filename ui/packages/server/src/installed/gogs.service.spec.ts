import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GogsService } from './gogs.service';

describe('GogsService', () => {
  let service: GogsService;
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        GogsService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, defaultValue?: string) => {
              if (key === 'GOGS_URL') return 'http://mock-gogs.test';
              if (key === 'GOGS_TOKEN') return 'mock-token';
              return defaultValue;
            },
          },
        },
      ],
    }).compile();

    service = module.get<GogsService>(GogsService);
    await module.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await module.close();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getInstalledAppNames()', () => {
    it('returns app names parsed from kustomization.yaml resources list (BACK-02)', async () => {
      const mockYaml = `resources:\n  - vaultwarden/\n  - gogs/\n  - litellm/\n`;
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => mockYaml,
      } as Response);

      const names = await service.getInstalledAppNames();

      expect(names).toEqual(['vaultwarden', 'gogs', 'litellm']);
    });

    it('strips trailing slashes from resources entries (BACK-02, Pitfall 7)', async () => {
      const mockYaml = `resources:\n  - vaultwarden/\n`;
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => mockYaml,
      } as Response);

      const names = await service.getInstalledAppNames();

      expect(names).toEqual(['vaultwarden']);
      expect(names[0]).not.toContain('/');
    });

    it('returns [] when Gogs responds with non-OK status (BACK-02)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const names = await service.getInstalledAppNames();

      expect(names).toEqual([]);
    });

    it('returns [] when Gogs is unreachable (network error) (BACK-02)', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const names = await service.getInstalledAppNames();

      expect(names).toEqual([]);
    });

    it('returns [] when kustomization.yaml has no resources key (BACK-02)', async () => {
      const mockYaml = `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\n`;
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => mockYaml,
      } as Response);

      const names = await service.getInstalledAppNames();

      expect(names).toEqual([]);
    });

    it('calls Gogs API with Bearer token auth header (BACK-02)', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => 'resources: []',
      } as Response);

      await service.getInstalledAppNames();

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://mock-gogs.test/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'token mock-token' }),
        }),
      );
    });
  });
});
