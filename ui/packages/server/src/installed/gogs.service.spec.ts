import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { GogsService } from './gogs.service';

const mockConfigService = {
  get: (key: string, defaultValue?: string) => {
    if (key === 'GOGS_URL') return 'http://mock-gogs.test';
    if (key === 'GOGS_USERNAME') return 'mock-user';
    if (key === 'GOGS_TOKEN') return 'mock-token';
    return defaultValue;
  },
} as unknown as ConfigService;

describe('GogsService', () => {
  let service: GogsService;

  beforeEach(() => {
    service = new GogsService(mockConfigService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createFile()', () => {
    it('calls PUT /api/v1/repos/flux/user-apps/contents/{path} with base64 content (INST-01)', async () => {
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
          headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from('mock-user:mock-token').toString('base64')}` }),
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
      const originalContent = 'apiVersion: source.toolkit.fluxcd.io/v1beta2';
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

    it('calls Gogs API with basic auth header (BACK-02)', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        text: async () => 'resources: []',
      } as Response);

      await service.getInstalledAppNames();

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://mock-gogs.test/api/v1/repos/flux/user-apps/raw/master/kustomization.yaml',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Basic ${Buffer.from('mock-user:mock-token').toString('base64')}` }),
        }),
      );
    });
  });
});
