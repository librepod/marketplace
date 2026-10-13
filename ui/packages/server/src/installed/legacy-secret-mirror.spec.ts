import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mergeLegacyIntoStored, LegacySecretMirror } from './legacy-secret-mirror';
import type { UserAppsRepoService } from './user-apps-repo.service';
import type { OpenBaoClient } from './openbao.client';

describe('mergeLegacyIntoStored', () => {
  it('merges absent keys only', () => {
    expect(mergeLegacyIntoStored('stringData:\n  A: "1"\n  B: "2"\n', { B: 'kept' }))
      .toEqual({ A: '1', B: 'kept' });
  });
  it('skips empty and unsubstituted values', () => {
    expect(mergeLegacyIntoStored('stringData:\n  A: ""\n  B: "${NOPE}"\n  C: "ok"\n', null))
      .toEqual({ C: 'ok' });
  });
  it('returns null when nothing new', () => {
    expect(mergeLegacyIntoStored('stringData:\n  A: "1"\n', { A: '1' })).toBeNull();
  });

  it('treats a file without stringData as nothing to add', () => {
    expect(mergeLegacyIntoStored('kind: ConfigMap\ndata:\n  A: b\n', null)).toBeNull();
  });
  it('existing OpenBao values win even against a different legacy value', () => {
    expect(mergeLegacyIntoStored('stringData:\n  A: "new"\n', { A: 'old' })).toBeNull();
  });
});

describe('LegacySecretMirror', () => {
  let mockRepo: {
    listInstalledApps: ReturnType<typeof vi.fn>;
    readAppFile: ReturnType<typeof vi.fn>;
  };
  let mockOpenBao: {
    readAppSettings: ReturnType<typeof vi.fn>;
    writeAppSettings: ReturnType<typeof vi.fn>;
  };
  let mirror: LegacySecretMirror;

  beforeEach(() => {
    mockRepo = {
      listInstalledApps: vi.fn(async () => [] as string[]),
      readAppFile: vi.fn(async () => null),
    };
    mockOpenBao = {
      readAppSettings: vi.fn(async () => null),
      writeAppSettings: vi.fn(async () => undefined),
    };
    mirror = new LegacySecretMirror(
      mockRepo as unknown as UserAppsRepoService,
      mockOpenBao as unknown as OpenBaoClient,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('mirrorOnce()', () => {
    it('writes absent legacy keys and reports what it mirrored', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['baikal', 'vaultwarden']);
      mockRepo.readAppFile.mockImplementation(async (app: string) =>
        app === 'baikal'
          ? 'stringData:\n  A: "1"\n  B: "2"\n'
          : 'stringData:\n  C: "ok"\n',
      );
      mockOpenBao.readAppSettings.mockImplementation(async (app: string) =>
        app === 'baikal' ? { B: 'kept' } : null,
      );

      await expect(mirror.mirrorOnce()).resolves.toEqual({ apps: 2, keys: 2 });
      expect(mockOpenBao.writeAppSettings).toHaveBeenNthCalledWith(1, 'baikal', {
        A: '1',
        B: 'kept',
      });
      expect(mockOpenBao.writeAppSettings).toHaveBeenNthCalledWith(2, 'vaultwarden', {
        C: 'ok',
      });
    });

    it('writes nothing when every legacy value is already stored', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['baikal']);
      mockRepo.readAppFile.mockResolvedValue('stringData:\n  A: "1"\n');
      mockOpenBao.readAppSettings.mockResolvedValue({ A: '1' });

      await expect(mirror.mirrorOnce()).resolves.toEqual({ apps: 0, keys: 0 });
      expect(mockOpenBao.writeAppSettings).not.toHaveBeenCalled();
    });

    it('skips an app whose snapshot fails and still mirrors the rest', async () => {
      mockRepo.listInstalledApps.mockResolvedValue(['broken', 'fine']);
      mockRepo.readAppFile.mockImplementation(async (app: string) => {
        if (app === 'broken') throw new Error('git exploded');
        return 'stringData:\n  A: "1"\n';
      });

      await expect(mirror.mirrorOnce()).resolves.toEqual({ apps: 1, keys: 1 });
      expect(mockOpenBao.writeAppSettings).toHaveBeenCalledTimes(1);
      expect(mockOpenBao.writeAppSettings).toHaveBeenCalledWith('fine', { A: '1' });
    });
  });

  describe('onModuleInit()', () => {
    it('mirrors fire-and-forget, then hourly, without blocking boot', async () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(mirror, 'mirrorOnce').mockResolvedValue({ apps: 0, keys: 0 });

      expect(mirror.onModuleInit()).toBeUndefined(); // does not await the mirror
      await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget promise run
      expect(spy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('survives the boot-time mirror failing', async () => {
      vi.useFakeTimers();
      vi.spyOn(mirror, 'mirrorOnce').mockRejectedValue(new Error('no bao'));

      expect(() => mirror.onModuleInit()).not.toThrow();
      await vi.advanceTimersByTimeAsync(0); // the rejection must not escape
    });
  });
});
