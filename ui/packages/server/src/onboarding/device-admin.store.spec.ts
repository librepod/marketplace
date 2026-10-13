import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeviceAdminStore } from './device-admin.store';

describe('DeviceAdminStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  // NB: the store's k8s client is stubbed via `client` (private) — no k8s
  // env is touched, so these run anywhere.

  it('load returns the decoded password (+ wgHost companion key)', async () => {
    const read = vi.fn().mockResolvedValue({
      data: {
        password: Buffer.from('pw1').toString('base64'),
        wgHost: Buffer.from('192.168.1.50').toString('base64'),
      },
    });
    const store = new DeviceAdminStore();
    vi.spyOn(store as any, 'client').mockReturnValue({ readNamespacedSecret: read });
    expect(await store.load()).toEqual({ password: 'pw1', wgHost: '192.168.1.50' });
    expect(read).toHaveBeenCalledWith({ name: 'marketplace-ui-admin-credential', namespace: 'marketplace-ui' });
  });

  it('load swallows absence/RBAC denial as empty', async () => {
    const store = new DeviceAdminStore();
    vi.spyOn(store as any, 'client').mockReturnValue({
      readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 404 }),
    });
    expect(await store.load()).toEqual({});
    vi.spyOn(store as any, 'client').mockReturnValue(undefined);
    expect(await store.load()).toEqual({});
  });

  it('save replaces when the secret exists', async () => {
    const replace = vi.fn().mockResolvedValue({});
    const create = vi.fn();
    const store = new DeviceAdminStore();
    vi.spyOn(store as any, 'client').mockReturnValue({ replaceNamespacedSecret: replace, createNamespacedSecret: create });
    await store.save('pw2');
    expect(replace).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('save creates after a 404 on replace', async () => {
    const replace = vi.fn().mockRejectedValue({ statusCode: 404 });
    const create = vi.fn().mockResolvedValue({});
    const store = new DeviceAdminStore();
    vi.spyOn(store as any, 'client').mockReturnValue({ replaceNamespacedSecret: replace, createNamespacedSecret: create });
    await store.save('pw3', '192.168.1.50');
    expect(create).toHaveBeenCalledWith({
      namespace: 'marketplace-ui',
      body: expect.objectContaining({ stringData: { password: 'pw3', wgHost: '192.168.1.50' } }),
    });
  });

  it('save throws when k8s is unavailable (callers must not rotate first)', async () => {
    const store = new DeviceAdminStore();
    vi.spyOn(store as any, 'client').mockReturnValue(undefined);
    await expect(store.save('pw4')).rejects.toThrow('k8s config unavailable');
  });
});
