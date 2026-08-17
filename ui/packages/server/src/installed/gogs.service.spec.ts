import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { GogsService } from './gogs.service';

const mockConfigService = {
  get: (key: string, defaultValue?: string) => {
    if (key === 'GOGS_URL') return 'http://mock-gogs.test';
    if (key === 'GOGS_USERNAME') return 'mock-user';
    if (key === 'GOGS_TOKEN') return 'mock-password';
    return defaultValue;
  },
} as unknown as ConfigService;

const MOCK_API_TOKEN = 'abc123def456';

async function initServiceWithMockToken(): Promise<GogsService> {
  const service = new GogsService(mockConfigService);
  vi.spyOn(global, 'fetch')
    .mockResolvedValueOnce({ ok: true, json: async () => ({ sha1: MOCK_API_TOKEN }) } as Response);
  await service.onModuleInit();
  vi.restoreAllMocks();
  return service;
}

describe('GogsService', () => {
  let service: GogsService;

  beforeEach(async () => {
    service = await initServiceWithMockToken();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit()', () => {
    it('creates an API token using Basic Auth with username/password', async () => {
      const svc = new GogsService(mockConfigService);
      const fetchSpy = vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sha1: 'new-token' }) } as Response);

      await svc.onModuleInit();

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://mock-gogs.test/api/v1/users/mock-user/tokens',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('mock-user:mock-password').toString('base64')}`,
          }),
        }),
      );
    });

    it('re-acquires the token on a later write when boot-time bootstrap 403s (Tier 2 install-500 flake)', async () => {
      // On a fresh cluster the flux user may not exist yet when onModuleInit runs,
      // so the token POST 403s. The old one-shot bootstrap left apiToken empty for
      // the container's whole lifetime → every install 500'd. ensureToken must
      // retry on the next authenticated call so the write succeeds once Gogs
      // catches up, instead of wedging.
      const svc = new GogsService(mockConfigService);

      // 1) boot-time bootstrap fails (flux user not ready) → token stays empty.
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 403 } as Response);
      await svc.onModuleInit();
      vi.restoreAllMocks();

      // 2) a later createFile: token POST now succeeds (Gogs caught up), then the
      //    PUT write goes through with the freshly acquired token — no 500.
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sha1: 'late-token' }) } as Response)
        .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) } as Response);

      await expect(
        svc.createFile('apps/baikal/source.yaml', 'content', 'install: add baikal'),
      ).resolves.not.toThrow();

      // the retry re-POSTed for a token, then wrote with `token late-token`.
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'http://mock-gogs.test/api/v1/users/mock-user/tokens',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'http://mock-gogs.test/api/v1/repos/flux/user-apps/contents/apps/baikal/source.yaml',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ Authorization: 'token late-token' }),
        }),
      );
    });
  });

  describe('ensureWritableToken()', () => {
    it('retries until Gogs provisions the flux user, then returns the token (first-click race)', async () => {
      // Fresh cluster: the first N token POSTs 403 (flux user not ready), then one
      // succeeds. ensureWritableToken must wait through the 403s so the first
      // install click succeeds instead of 500ing. Fake timers so the backoff
      // sleeps don't slow the test.
      vi.useFakeTimers();
      const svc = new GogsService(mockConfigService);
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sha1: 'ready-token' }) } as Response);

      const promise = svc.ensureWritableToken();
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('ready-token');
      vi.useRealTimers();
    });

    it('throws after exhausting retries when Gogs never provisions the user', async () => {
      vi.useFakeTimers();
      const svc = new GogsService(mockConfigService);
      vi.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 403 } as Response);

      const promise = svc.ensureWritableToken();
      // Attach the rejection expectation before advancing timers so the rejection
      // is never unhandled.
      const assertion = expect(promise).rejects.toThrow(/token unavailable/i);
      await vi.runAllTimersAsync();
      await assertion;
      vi.useRealTimers();
    });

    it('returns immediately without retrying when a token is already held', async () => {
      // service (from beforeEach) already has a token; must not POST again.
      const fetchSpy = vi.spyOn(global, 'fetch');
      await expect(service.ensureWritableToken()).resolves.toBe(MOCK_API_TOKEN);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('createFile()', () => {
    it('calls PUT with token auth and base64 content (INST-01)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ commit: { sha: 'abc123' } }),
      } as Response);

      await service.createFile('apps/vaultwarden/source.yaml', 'content-here', 'install: add vaultwarden');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://mock-gogs.test/api/v1/repos/flux/user-apps/contents/apps/vaultwarden/source.yaml',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({ Authorization: `token ${MOCK_API_TOKEN}` }),
        }),
      );
      const callArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callArgs.body as string) as { content: string; message: string };
      expect(body.content).toBe(Buffer.from('content-here').toString('base64'));
      expect(body.message).toBe('install: add vaultwarden');
    });

    it('throws Error when Gogs responds with non-OK status (INST-01)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(
        service.createFile('apps/vaultwarden/source.yaml', 'content', 'msg'),
      ).rejects.toThrow();
    });
  });

  describe('getFileContents()', () => {
    it('returns decoded content and sha when file exists (INST-01)', async () => {
      const originalContent = 'apiVersion: source.toolkit.fluxcd.io/v1';
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: Buffer.from(originalContent).toString('base64'),
          sha: 'abc123',
        }),
      } as Response);

      const result = await service.getFileContents('kustomization.yaml');

      expect(result).toEqual({ content: originalContent, sha: 'abc123' });
    });

    it('returns null when file does not exist (404) (INST-02)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const result = await service.getFileContents('kustomization.yaml');

      expect(result).toBeNull();
    });
  });

  describe('addToRootKustomization()', () => {
    it('adds apps/<name> to resources list and PUTs updated YAML (INST-01)', async () => {
      const existingYaml = 'resources:\n  - apps/frpc\n';
      vi.spyOn(service, 'getFileContents').mockResolvedValueOnce({
        content: existingYaml,
        sha: 'old-sha',
      });
      vi.spyOn(service, 'createFile').mockResolvedValueOnce(undefined);

      await service.addToRootKustomization('vaultwarden');

      expect(service.createFile).toHaveBeenCalledWith(
        'kustomization.yaml',
        expect.stringContaining('apps/vaultwarden'),
        expect.any(String),
      );
      expect(service.createFile).toHaveBeenCalledWith(
        'kustomization.yaml',
        expect.stringContaining('apps/frpc'),
        expect.any(String),
      );
    });

    it('does not duplicate entry if app already in resources (INST-01)', async () => {
      const existingYaml = 'resources:\n  - apps/vaultwarden\n';
      vi.spyOn(service, 'getFileContents').mockResolvedValueOnce({
        content: existingYaml,
        sha: 'old-sha',
      });
      vi.spyOn(service, 'createFile').mockResolvedValueOnce(undefined);

      await service.addToRootKustomization('vaultwarden');

      const writtenContent = (service.createFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      const matches = writtenContent.match(/apps\/vaultwarden/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('removeFromRootKustomization()', () => {
    it('removes apps/<name> from resources list and PUTs updated YAML (INST-02)', async () => {
      const existingYaml = 'resources:\n  - apps/frpc\n  - apps/vaultwarden\n';
      vi.spyOn(service, 'getFileContents').mockResolvedValueOnce({
        content: existingYaml,
        sha: 'old-sha',
      });
      vi.spyOn(service, 'createFile').mockResolvedValueOnce(undefined);

      await service.removeFromRootKustomization('vaultwarden');

      const writtenContent = (service.createFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(writtenContent).toContain('apps/frpc');
      expect(writtenContent).not.toContain('apps/vaultwarden');
    });
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

    it('strips the apps/ path prefix from resources entries (regression)', async () => {
      // addToRootKustomization writes entries as "apps/<name>"; getInstalledAppNames
      // must return bare names so enrich can match them against app.name. A bare
      // .replace(/\/$/) leaves the apps/ prefix and every install reads as
      // not_installed — the Tier 1 e2e install spec catches this end-to-end.
      const mockYaml = `resources:\n  - apps/vaultwarden\n  - apps/litellm/\n`;
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => mockYaml,
      } as Response);

      const names = await service.getInstalledAppNames();

      expect(names).toEqual(['vaultwarden', 'litellm']);
      expect(names.every((n) => !n.includes('/'))).toBe(true);
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

    it('calls Gogs API with token auth header (BACK-02)', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => 'resources: []',
      } as Response);

      await service.getInstalledAppNames();

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://mock-gogs.test/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `token ${MOCK_API_TOKEN}` }),
        }),
      );
    });
  });
});
