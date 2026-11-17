import { describe, it, expect, vi } from 'vitest';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiException,
  type ApisApi,
  type CoreV1Api,
  type CustomObjectsApi,
} from '@kubernetes/client-node';
import { DeviceService } from './device.service';

const groups = (...versions: string[]) => ({
  groups: [
    { name: 'apps', versions: [{ version: 'v1' }] },
    ...(versions.length
      ? [
          {
            name: 'os.librepod.org',
            versions: versions.map((version) => ({ version })),
          },
        ]
      : []),
  ],
});
const dev = (name: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name, resourceVersion: '1' },
  ...extra,
});

function make(
  opts: {
    groups?: unknown;
    items?: unknown[];
    env?: Record<string, string>;
  } = {},
) {
  const apis = {
    getAPIVersions: vi
      .fn()
      .mockResolvedValue(opts.groups ?? groups('v1alpha1')),
  };
  const objects = {
    listClusterCustomObject: vi
      .fn()
      .mockResolvedValue({ items: opts.items ?? [] }),
    getClusterCustomObject: vi
      .fn()
      .mockResolvedValue({ usage: { cpu: '500m', memory: '4Gi' } }),
    patchClusterCustomObject: vi.fn(),
  };
  const core = {
    readNode: vi.fn().mockResolvedValue({
      status: { capacity: { cpu: '4', memory: '16Gi' } },
    }),
  };
  const svc = new DeviceService(
    objects as unknown as CustomObjectsApi,
    core as unknown as CoreV1Api,
    apis as unknown as ApisApi,
    new ConfigService(opts.env ?? { NODE_NAME: 'node-a' }),
  );
  return { svc, apis, objects, core };
}

describe('DeviceService.read', () => {
  it('no os.librepod.org group → absent', async () => {
    const { svc, objects } = make({ groups: groups() });
    expect(await svc.read()).toEqual({ os: 'absent' });
    expect(objects.listClusterCustomObject).not.toHaveBeenCalled();
  });

  it('group served at v1alpha1 only → lists v1alpha1; at both → lists v1beta1', async () => {
    const a = make({ groups: groups('v1alpha1') });
    await a.svc.read();
    expect(a.objects.listClusterCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'os.librepod.org',
        version: 'v1alpha1',
        plural: 'devices',
      }),
    );
    const b = make({ groups: groups('v1alpha1', 'v1beta1') });
    await b.svc.read();
    expect(b.objects.listClusterCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v1beta1' }),
    );
  });

  it('group served at none of our versions → 503, never absent', async () => {
    await expect(make({ groups: groups('v2') }).svc.read()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('empty list → starting', async () => {
    expect(await make({ items: [] }).svc.read()).toEqual({ os: 'starting' });
  });

  it('picks the Device named NODE_NAME, else the first by name', async () => {
    const items = [dev('node-b'), dev('node-a')];
    const named = await make({
      items,
      env: { NODE_NAME: 'node-b' },
    }).svc.read();
    expect(named).toMatchObject({ os: 'present', device: { name: 'node-b' } });
    const unset = await make({ items, env: {} }).svc.read();
    expect(unset).toMatchObject({ os: 'present', device: { name: 'node-a' } });
  });

  it('metrics from metrics.k8s.io and Node capacity', async () => {
    const { svc, objects } = make({ items: [dev('node-a')] });
    const info = await svc.read();
    expect(info).toMatchObject({
      device: {
        metrics: {
          cpuPercent: 12.5,
          memoryUsedBytes: 4294967296,
          memoryTotalBytes: 17179869184,
        },
      },
    });
    expect(objects.getClusterCustomObject).toHaveBeenCalledWith({
      group: 'metrics.k8s.io',
      version: 'v1beta1',
      plural: 'nodes',
      name: 'node-a',
    });
  });

  it('a metrics failure keeps the Device and sets metrics null', async () => {
    const { svc, objects } = make({ items: [dev('node-a')] });
    objects.getClusterCustomObject.mockRejectedValue(
      new Error('no metrics-server'),
    );
    expect(await svc.read()).toMatchObject({
      os: 'present',
      device: { metrics: null },
    });
  });

  it('a list failure (refused, 403) → 503', async () => {
    const { svc, objects } = make();
    objects.listClusterCustomObject.mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 403 }),
    );
    await expect(svc.read()).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('DeviceService.setupCodeHash', () => {
  it('the hash when present; null when absent, starting, or no field', async () => {
    const withHash = make({
      items: [dev('node-a', { status: { setupCodeHash: '$2b$04$x' } })],
    });
    expect(await withHash.svc.setupCodeHash()).toBe('$2b$04$x');
    expect(await make({ groups: groups() }).svc.setupCodeHash()).toBeNull();
    expect(await make({ items: [] }).svc.setupCodeHash()).toBeNull();
    expect(
      await make({ items: [dev('node-a')] }).svc.setupCodeHash(),
    ).toBeNull();
  });

  it("throws when Kubernetes can't answer", async () => {
    const { svc, objects } = make();
    objects.listClusterCustomObject.mockRejectedValue(new Error('refused'));
    await expect(svc.setupCodeHash()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

describe('DeviceService.write', () => {
  const fresh = () => new Date().toISOString();
  const powerDev = (
    status: Record<string, unknown> = {},
    spec: Record<string, unknown> = { power: { id: 3 } },
  ) =>
    dev('node-a', {
      spec,
      status: { handled: { power: 5 }, updated: fresh(), ...status },
    });

  it('patches only the section, numbered max(spec, handled)+1, with resourceVersion', async () => {
    const { svc, objects } = make({
      items: [
        { ...powerDev(), metadata: { name: 'node-a', resourceVersion: '41' } },
      ],
    });
    objects.patchClusterCustomObject.mockResolvedValue({});
    await svc.write('power', { action: 'reboot' });
    const [arg, opt] = objects.patchClusterCustomObject.mock.calls[0];
    expect(arg).toMatchObject({
      group: 'os.librepod.org',
      plural: 'devices',
      name: 'node-a',
      body: {
        metadata: { resourceVersion: '41' },
        spec: { power: { id: 6, action: 'reboot' } },
      },
    });
    expect(arg.body).toEqual({
      metadata: { resourceVersion: '41' },
      spec: { power: { id: 6, action: 'reboot' } },
    });
    expect(opt).toBeDefined(); // merge-patch header option
  });

  it('retries once on a 409 Conflict, re-reading first', async () => {
    const { svc, objects } = make({ items: [powerDev()] });
    objects.patchClusterCustomObject
      .mockRejectedValueOnce(new ApiException(409, 'conflict', {}, {}))
      .mockResolvedValue({});
    await svc.write('power', { action: 'reboot' });
    expect(objects.patchClusterCustomObject).toHaveBeenCalledTimes(2);
    expect(
      objects.listClusterCustomObject.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('a second conflict → ConflictException', async () => {
    const { svc, objects } = make({ items: [powerDev()] });
    objects.patchClusterCustomObject.mockRejectedValue(
      new ApiException(409, 'conflict', {}, {}),
    );
    await expect(svc.write('power', { action: 'reboot' })).rejects.toThrow(
      'Changed elsewhere, try again',
    );
  });

  it('refuses install and power while not reporting; allows updates and sshKeys', async () => {
    const old = dev('node-a', { status: { updated: '2020-01-01T00:00:00Z' } });
    const { svc, objects } = make({ items: [old] });
    objects.patchClusterCustomObject.mockResolvedValue({});
    await expect(svc.write('install', { when: 'now' })).rejects.toThrow(
      "hasn't reported since",
    );
    await expect(svc.write('power', { action: 'reboot' })).rejects.toThrow(
      ConflictException,
    );
    await svc.write('updates', {
      channel: 'stable',
      auto: true,
      timezone: 'UTC',
    });
    await svc.write('sshKeys', { keys: [] });
    expect(objects.patchClusterCustomObject).toHaveBeenCalledTimes(2);
  });

  it('refuses power while an update is installing', async () => {
    const { svc } = make({
      items: [powerDev({ update: { state: 'installing' } })],
    });
    await expect(svc.write('power', { action: 'reboot' })).rejects.toThrow(
      'an update is installing',
    );
  });

  it('refuses any write when there is no OS or it is starting', async () => {
    for (const m of [make({ groups: groups() }), make({ items: [] })]) {
      await expect(m.svc.write('updates', {})).rejects.toThrow(
        "LibrePod OS isn't reporting yet",
      );
    }
  });

  it('answers with the fresh DeviceInfo', async () => {
    const { svc, objects } = make({ items: [powerDev()] });
    objects.patchClusterCustomObject.mockResolvedValue({});
    objects.listClusterCustomObject
      .mockResolvedValueOnce({ items: [powerDev()] })
      .mockResolvedValueOnce({ items: [powerDev({}, { power: { id: 6 } })] });
    const info = await svc.write('power', { action: 'reboot' });
    expect(info).toMatchObject({
      os: 'present',
      device: { pending: { power: true } },
    });
  });
});

describe('DeviceService.seedTimezone', () => {
  const seedable = (
    status: Record<string, unknown> = {},
    spec?: Record<string, unknown>,
  ) =>
    dev('node-a', {
      spec,
      status: {
        handled: { updates: 0 },
        updated: new Date().toISOString(),
        ...status,
      },
    });
  const run = async (item: unknown, tz: unknown = 'Europe/Minsk') => {
    const m = make(item ? { items: [item] } : { items: [] });
    m.objects.patchClusterCustomObject.mockResolvedValue({});
    await m.svc.seedTimezone(tz);
    return m.objects.patchClusterCustomObject;
  };

  it('seeds updates when nobody ever answered', async () => {
    const patch = await run(
      seedable({ update: { settings: { channel: 'beta', auto: false } } }),
    );
    expect(patch.mock.calls[0][0].body.spec.updates).toEqual({
      rev: 1,
      channel: 'beta',
      auto: false,
      timezone: 'Europe/Minsk',
    });
  });
  it('defaults to stable + auto on when the device reports no settings', async () => {
    const patch = await run(seedable());
    expect(patch.mock.calls[0][0].body.spec.updates).toEqual({
      rev: 1,
      channel: 'stable',
      auto: true,
      timezone: 'Europe/Minsk',
    });
  });
  it('does nothing when handled.updates > 0, when spec.updates exists, when absent/starting, or for an invalid zone', async () => {
    expect(
      await run(seedable({ handled: { updates: 2 } })),
    ).not.toHaveBeenCalled();
    expect(
      await run(seedable({}, { updates: { rev: 1 } })),
    ).not.toHaveBeenCalled();
    expect(await run(null)).not.toHaveBeenCalled();
    expect(await run(seedable(), 'Mars/Base')).not.toHaveBeenCalled();
    const absent = make({ groups: groups() });
    await absent.svc.seedTimezone('UTC');
    expect(absent.objects.patchClusterCustomObject).not.toHaveBeenCalled();
  });
  it('swallows and logs a failure', async () => {
    const m = make({ items: [seedable()] });
    m.objects.patchClusterCustomObject.mockRejectedValue(new Error('boom'));
    await expect(m.svc.seedTimezone('UTC')).resolves.toBeUndefined();
  });
});
