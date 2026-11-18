import { describe, it, expect } from 'vitest';
import { toDeviceView, nextNumber, type RawDevice } from './device-view';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const bare: RawDevice = { metadata: { name: 'node-a' } };
const withStatus = (
  status: Record<string, unknown>,
  spec?: RawDevice['spec'],
): RawDevice => ({
  metadata: { name: 'node-a' },
  status,
  spec,
});

describe('toDeviceView', () => {
  it('maps a full Device', () => {
    const v = toDeviceView(
      withStatus({
        updated: '2026-11-16T11:58:00Z',
        handled: { updates: 3, install: 7, power: 1, sshKeys: 2 },
        rejected: { power: 'an update is installing' },
        update: { state: 'ready', available: '0.5.1' },
        system: {
          version: '0.5.0',
          rootDisk: { sizeBytes: 32e9, usedBytes: 9.8e9 },
          dataDisk: { present: true, sizeBytes: 480e9, usedBytes: 412e9 },
        },
        sshKeys: ['ssh-ed25519 AAAAC3 me@laptop'],
      }),
      null,
      NOW,
    );
    expect(v.reporting).toBe(true);
    expect(v.version).toBe('0.5.0');
    expect(v.update?.state).toBe('ready');
    expect(v.rejected.power).toBe('an update is installing');
    expect(v.sshKeys).toHaveLength(1);
    expect(v.rootDisk).toEqual({ sizeBytes: 32e9, usedBytes: 9.8e9 });
  });

  it('an older Device with only metadata maps to nulls', () => {
    expect(toDeviceView(bare, null, NOW)).toMatchObject({
      reportedAt: null,
      reporting: false,
      version: null,
      rootDisk: null,
      dataDisk: null,
      update: null,
      sshKeys: [],
      rejected: {},
      pending: { updates: false, install: false, power: false, sshKeys: false },
    });
  });

  it('reporting is false once status.updated is older than 10 minutes', () => {
    expect(
      toDeviceView(withStatus({ updated: '2026-11-16T11:49:59Z' }), null, NOW)
        .reporting,
    ).toBe(false);
    expect(
      toDeviceView(withStatus({ updated: '2026-11-16T11:50:01Z' }), null, NOW)
        .reporting,
    ).toBe(true);
  });

  it('pending when spec number is above handled', () => {
    const p = (id: number) =>
      toDeviceView(
        withStatus({ handled: { power: 1 } }, { power: { id } }),
        null,
        NOW,
      ).pending.power;
    expect(p(2)).toBe(true);
    expect(p(1)).toBe(false);
  });

  it('nothing reads pending after a rollback (spec below handled)', () => {
    const v = toDeviceView(
      withStatus({ handled: { updates: 5 } }, { updates: { rev: 3 } }),
      null,
      NOW,
    );
    expect(v.pending.updates).toBe(false);
  });
});

describe('nextNumber', () => {
  it('takes the larger of spec and handled, plus one', () => {
    expect(
      nextNumber(
        withStatus({ handled: { updates: 5 } }, { updates: { rev: 3 } }),
        'updates',
      ),
    ).toBe(6);
    expect(
      nextNumber(
        withStatus({ handled: { updates: 5 } }, { updates: { rev: 6 } }),
        'updates',
      ),
    ).toBe(7);
    expect(nextNumber(bare, 'updates')).toBe(1);
    expect(
      nextNumber(
        withStatus({ handled: { power: 5 } }, { power: { id: 3 } }),
        'power',
      ),
    ).toBe(6);
  });
});
