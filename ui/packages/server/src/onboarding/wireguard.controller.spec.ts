import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { WireguardController } from './wireguard.controller';
import type { WgEasyService } from './wg-easy.service';

function makeController(wg: Partial<WgEasyService>) {
  return new WireguardController({ listClients: vi.fn(), createClient: vi.fn(), ...(wg as object) } as unknown as WgEasyService);
}

function fakeRes() {
  return { setHeader: vi.fn(), send: vi.fn() } as unknown as Response;
}

describe('WireguardController', () => {
  it('lists peers', async () => {
    const peers = [{ clientId: 'a', name: 'phone', enabled: true, latestHandshakeAt: null }];
    const ctrl = makeController({ listClients: vi.fn().mockResolvedValue(peers) });
    expect(await ctrl.list()).toEqual({ peers });
  });

  it('creates a peer, defaulting the device name', async () => {
    const createClient = vi.fn().mockResolvedValue({ clientId: 'c1' });
    const ctrl = makeController({ createClient });
    expect(await ctrl.createPeer({ name: '  phone ' })).toEqual({ clientId: 'c1', name: 'phone' });
    expect(createClient).toHaveBeenCalledWith('phone');
    expect(await ctrl.createPeer({})).toEqual({ clientId: 'c1', name: 'my-device' });
  });

  it('rejects dangerous names and ids', async () => {
    const ctrl = makeController({});
    await expect(ctrl.createPeer({ name: 'x'.repeat(80) })).rejects.toThrow(BadRequestException);
    await expect(ctrl.createPeer({ name: 'a/b' })).rejects.toThrow(BadRequestException);
    await expect(ctrl.configuration('../etc', fakeRes())).rejects.toThrow(BadRequestException);
  });

  it('streams the configuration with an attachment header', async () => {
    const ctrl = makeController({ clientConfiguration: vi.fn().mockResolvedValue('[Interface]') });
    const res = fakeRes();
    await ctrl.configuration('c1', res);
    expect(res.setHeader).toHaveBeenCalledWith('content-disposition', 'attachment; filename="librepod-c1.conf"');
    expect(res.send).toHaveBeenCalledWith('[Interface]');
  });

  it('streams the QR svg', async () => {
    const ctrl = makeController({ clientQrSvg: vi.fn().mockResolvedValue('<svg/>') });
    const res = fakeRes();
    await ctrl.qrcode('c1', res);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'image/svg+xml');
    expect(res.send).toHaveBeenCalledWith('<svg/>');
  });
});
