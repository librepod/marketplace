import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingStore } from './onboarding-store';
import type { DeviceService } from '../device/device.service';
import { SETUP_CODE_ALPHABET, formatSetupCode } from './setup-code';
import { OpenBaoCasMismatchError, OpenBaoUnavailableError, type OpenBaoClient } from '../installed/openbao.client';
import { FakeKv } from '../../test/fixtures/fake-kv';

const RECORD = 'marketplace-ui/onboarding';

function makeStore(kv = new FakeKv(), env: Record<string, string> = {}, device?: { setupCodeHash: ReturnType<typeof vi.fn> }) {
  return { store: new OnboardingStore(kv as unknown as OpenBaoClient, new ConfigService(env), device as unknown as DeviceService), kv };
}

describe('OnboardingStore', () => {
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.BOOTSTRAP_MODE_OVERRIDE;
  });

  describe('the record', () => {
    it('is created on first use: open, a fresh 12-character code, generation 1', async () => {
      const { store, kv } = makeStore();
      const record = await store.record();
      expect(record).toMatchObject({
        state: 'open', generation: 1, account: null, accountGeneration: null, claimedAt: null, finishedAt: null,
      });
      expect(record.code).toMatch(new RegExp(`^[${SETUP_CODE_ALPHABET}]{12}$`));
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open', code: record.code, generation: 1 });
    });

    it('is created with check-and-set: when another pod creates it first, theirs wins', async () => {
      const kv = new FakeKv();
      const { store } = makeStore(kv);
      const theirs = {
        state: 'open', code: 'THEIRCODE234', generation: 1, account: null, accountGeneration: null,
        createdAt: '2026-10-14T09:00:00.000Z', claimedAt: null, finishedAt: null,
      };
      const read = kv.readEntry.bind(kv);
      // The other pod writes between our read (nothing yet) and our create.
      vi.spyOn(kv, 'readEntry').mockImplementationOnce(async (mount, path) => {
        const before = await read(mount, path);
        await kv.writeEntry(mount, path, theirs);
        return before;
      });
      expect((await store.record()).code).toBe('THEIRCODE234');
    });

    it('lives in the configured system mount', async () => {
      const { store, kv } = makeStore(new FakeKv(), { OPENBAO_SYSTEM_MOUNT: 'sys' });
      await store.record();
      expect(kv.get('sys', RECORD)).toBeDefined();
    });

    it('is cached for at most 5 seconds, so a reset from another process lands without a restart', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-14T10:00:00Z') });
      const kv = new FakeKv();
      const { store } = makeStore(kv);
      const first = await store.record();
      await kv.writeEntry('system', RECORD, { ...first, code: 'NEWCODE23456', generation: 2 });
      expect((await store.record()).generation).toBe(1);
      vi.advanceTimersByTime(5_001);
      expect((await store.record()).generation).toBe(2);
    });

    it('rejects while OpenBao cannot answer', async () => {
      const kv = new FakeKv();
      kv.failWith = new OpenBaoUnavailableError('sealed');
      await expect(makeStore(kv).store.record()).rejects.toThrow('sealed');
    });

    it('knows a finished device past the cache: a later OpenBao outage keeps knownFinished', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-14T10:00:00Z') });
      const kv = new FakeKv();
      const { store } = makeStore(kv);
      const open = await store.record();
      expect(store.knownFinished).toBe(false);
      await store.save({ ...open, state: 'finished', finishedAt: 'f' });
      expect(store.knownFinished).toBe(true);
      vi.advanceTimersByTime(5_001);
      kv.failWith = new OpenBaoUnavailableError('sealed');
      await expect(store.record()).rejects.toThrow('sealed');
      expect(store.knownFinished).toBe(true);
    });

    it('forgets the finish once OpenBao answers otherwise: a reset from the CLI is seen', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-14T10:00:00Z') });
      const kv = new FakeKv();
      const { store } = makeStore(kv);
      await store.save({ ...(await store.record()), state: 'finished', finishedAt: 'f' });
      await makeStore(kv).store.reset();
      vi.advanceTimersByTime(5_001);
      expect((await store.record()).state).toBe('open');
      expect(store.knownFinished).toBe(false);
    });

    it('a malformed record is an error, never a guessed state', async () => {
      const kv = new FakeKv();
      await kv.writeEntry('system', RECORD, { state: 'bogus', code: 'X', generation: 1 });
      await expect(makeStore(kv).store.record()).rejects.toThrow(/malformed/);
    });
  });

  describe('start-up', () => {
    it('logs the setup code while open', async () => {
      const { store } = makeStore();
      await store.start();
      const { code } = await store.record();
      expect(log).toHaveBeenCalledWith(
        `LibrePod setup code: ${formatSetupCode(code)} — open http://<this device's IP> to set up`,
      );
    });

    it('logs it while claimed too, and never once finished', async () => {
      const kv = new FakeKv();
      const base = { code: '7KQMX3RT9VHC', generation: 1, account: null, accountGeneration: null, createdAt: 't', finishedAt: null };
      await kv.writeEntry('system', RECORD, { ...base, state: 'claimed', claimedAt: 'c' });
      await makeStore(kv).store.start();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('LibrePod setup code: 7KQM-X3RT-9VHC'));

      log.mockClear();
      const finished = new FakeKv();
      await finished.writeEntry('system', RECORD, { ...base, state: 'finished', claimedAt: 'c', finishedAt: 'f' });
      await makeStore(finished).store.start();
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('setup code'));
    });

    it('retries in the background while OpenBao is not ready, then logs the code', async () => {
      vi.useFakeTimers();
      const kv = new FakeKv();
      kv.failWith = new OpenBaoUnavailableError('sealed');
      const { store } = makeStore(kv);
      await store.start();
      expect(log).not.toHaveBeenCalled();
      kv.failWith = null;
      await vi.advanceTimersByTimeAsync(5_000);
      // the retried start() is a chain of awaits; waitFor keeps ticking until it logs
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('LibrePod setup code: ')));
      store.onModuleDestroy();
    });

    it('does nothing under BOOTSTRAP_MODE_OVERRIDE (Tier 1 has no system/ mount)', () => {
      process.env.BOOTSTRAP_MODE_OVERRIDE = 'finished';
      const kv = new FakeKv();
      const read = vi.spyOn(kv, 'readEntry');
      makeStore(kv).store.onModuleInit();
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('logSetupCode — a browser entering the wizard', () => {
    it('re-logs the code, at most once a minute per code (the wizard polls every 4s)', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-14T10:00:00Z') });
      const { store } = makeStore();
      const record = await store.record();
      store.logSetupCode(record);
      store.logSetupCode(record);
      expect(log).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_001);
      store.logSetupCode(record);
      expect(log).toHaveBeenCalledTimes(2);
    });

    it('a new code (a reset while this pod was running) logs immediately; a finished record never', async () => {
      const { store } = makeStore();
      const record = await store.record();
      store.logSetupCode(record);
      log.mockClear();
      store.logSetupCode({ ...record, code: 'NEWCODE23456', generation: 2 });
      expect(log).toHaveBeenCalledTimes(1);
      log.mockClear();
      store.logSetupCode({ ...record, state: 'finished', finishedAt: 'f' });
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('transitions', () => {
    it('save() writes the whole record and refreshes the cache', async () => {
      const { store, kv } = makeStore();
      const open = await store.record();
      await store.save({ ...open, state: 'claimed', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'claimed', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect((await store.record()).state).toBe('claimed');
    });

    it('finishIfClaimed() finishes a claimed record once, and is a no-op otherwise', async () => {
      const { store, kv } = makeStore();
      const open = await store.record();
      expect(await store.finishIfClaimed('owner')).toBe(false);
      await store.save({ ...open, state: 'claimed', account: 'owner', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect(await store.finishIfClaimed('owner')).toBe(true);
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'finished', finishedAt: expect.any(String) });
      expect(await store.finishIfClaimed('owner')).toBe(false);
    });

    it('finishIfClaimed() finishes only for the recorded account', async () => {
      const { store } = makeStore();
      const open = await store.record();
      await store.save({ ...open, state: 'claimed', account: 'owner', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect(await store.finishIfClaimed('someone-else')).toBe(false);
      expect(await store.finishIfClaimed('owner')).toBe(true);
    });

    it('finishIfClaimed() never finishes a claimed record with no account yet', async () => {
      const { store } = makeStore();
      const open = await store.record();
      await store.save({ ...open, state: 'claimed', account: null, claimedAt: '2026-10-14T10:00:00.000Z' });
      expect(await store.finishIfClaimed('owner')).toBe(false);
    });

    it('saveAdminPassword() with cas 0 refuses to overwrite an existing password', async () => {
      const { store } = makeStore();
      await store.saveAdminPassword('first-0123456789', { cas: 0 });
      await expect(store.saveAdminPassword('second-012345678', { cas: 0 })).rejects.toThrow(OpenBaoCasMismatchError);
      expect(await store.adminPassword()).toBe('first-0123456789');
    });

    it('only a sign-in since the claim finishes — an older session must not end a reopened wizard', async () => {
      const { store } = makeStore();
      const open = await store.record();
      const claimedAt = Date.parse('2026-10-14T10:00:00.000Z');
      await store.save({ ...open, state: 'claimed', account: 'owner', claimedAt: new Date(claimedAt).toISOString() });
      expect(await store.finishIfClaimed('owner', claimedAt - 1_000)).toBe(false);
      expect(await store.finishIfClaimed('owner', claimedAt + 1_000)).toBe(true);
    });

    it('reset() reopens: a new code, open, generation + 1, the account kept, timestamps cleared', async () => {
      const { store, kv } = makeStore();
      const open = await store.record();
      await store.save({
        ...open, state: 'finished', account: 'alex', accountGeneration: 1, claimedAt: 'c', finishedAt: 'f',
      });
      const code = await store.reset();
      expect(code).not.toBe(open.code);
      expect(kv.get('system', RECORD)).toEqual({
        state: 'open', code, generation: 2, account: 'alex', accountGeneration: 1,
        createdAt: open.createdAt, claimedAt: null, finishedAt: null,
      });
      expect((await store.record()).generation).toBe(2);
    });

    it('reset() also repairs a missing or malformed record', async () => {
      const kv = new FakeKv();
      await kv.writeEntry('system', RECORD, { state: 'bogus' });
      const { store } = makeStore(kv);
      await store.reset();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open', generation: 1, account: null });
    });

    it('save() never undoes a write since the record was read: a reset by the CLI stands', async () => {
      const kv = new FakeKv();
      const { store } = makeStore(kv);
      const cached = await store.record();
      const code = await makeStore(kv).store.reset(); // the CLI: another process, the same entry
      await expect(store.save({ ...cached, state: 'claimed', claimedAt: 'c' })).rejects.toThrow(
        OpenBaoCasMismatchError,
      );
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open', code, generation: 2 });
      // and the next read is fresh, not the cached record for up to 5 s more
      expect((await store.record()).generation).toBe(2);
    });
  });

  describe('a setup code hash from LibrePod OS (Device status.setupCodeHash)', () => {
    const HASH = bcrypt.hashSync('7KQMX3RT9VHC', 4);
    const OTHER_SALT = bcrypt.hashSync('7KQMX3RT9VHC', 4);
    const stub = (value: string | null) => ({ setupCodeHash: vi.fn().mockResolvedValue(value) });
    const withHash = (kv = new FakeKv(), device = stub(HASH)) => ({ ...makeStore(kv, {}, device), device });

    it('a new record stores the hash, never a raw code', async () => {
      const { store, kv } = withHash();
      expect((await store.record()).code).toBe(HASH);
      expect(JSON.stringify(kv.get('system', RECORD))).not.toContain('7KQMX3RT9VHC');
    });

    it('no OS, starting, or no field → a minted code', async () => {
      const { store } = withHash(new FakeKv(), stub(null));
      expect((await store.record()).code).toMatch(new RegExp(`^[${SETUP_CODE_ALPHABET}]{12}$`));
    });

    it('an open record with a minted code adopts the hash when it appears', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-10T10:00:00Z') });
      const kv = new FakeKv();
      const device = stub(null);
      const { store } = withHash(kv, device);
      const before = await store.record();
      device.setupCodeHash.mockResolvedValue(HASH);
      vi.advanceTimersByTime(5_001);
      expect(await store.record()).toMatchObject({ state: 'open', code: HASH, generation: before.generation });
      expect(kv.get('system', RECORD)).toMatchObject({ code: HASH });
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/now the one printed on this device's sticker/));
    });

    it('a stored hash is never replaced by another hash of the same code', async () => {
      vi.useFakeTimers({ now: new Date('2026-11-10T10:00:00Z') });
      const kv = new FakeKv();
      const device = stub(HASH);
      const { store } = withHash(kv, device);
      await store.record();
      log.mockClear();
      const version = (await store.record()).version;
      device.setupCodeHash.mockResolvedValue(OTHER_SALT);
      vi.advanceTimersByTime(5_001);
      const after = await store.record();
      expect(after.code).toBe(HASH);
      expect(after.version).toBe(version);
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/now the one printed/));
    });

    it('never changes a claimed or finished record', async () => {
      for (const state of ['claimed', 'finished'] as const) {
        const kv = new FakeKv();
        await kv.writeEntry('system', RECORD, {
          state, code: 'OLDCODE23456', generation: 1, account: 'alex', accountGeneration: 1,
          createdAt: 'a', claimedAt: 'c', finishedAt: state === 'finished' ? 'f' : null,
        });
        const { store, device } = withHash(kv);
        expect((await store.record()).code).toBe('OLDCODE23456');
        expect(device.setupCodeHash).not.toHaveBeenCalled();
      }
    });

    it('reset() goes back to the hash', async () => {
      const { store } = withHash();
      await store.save({ ...(await store.record()), state: 'finished', finishedAt: 'f' });
      expect(await store.reset()).toBe(HASH);
    });

    it('a value that is not a bcrypt hash is an error where a code is chosen', async () => {
      await expect(withHash(new FakeKv(), stub('7KQMX3RT9VHC')).store.record()).rejects.toThrow(/not a bcrypt hash/);
      await expect(withHash(new FakeKv(), stub('7KQMX3RT9VHC')).store.reset()).rejects.toThrow(/not a bcrypt hash/);
    });

    it('the log line points at the sticker and never contains the hash', async () => {
      const { store } = withHash();
      await store.start();
      store.logSetupCode(await store.record());
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines.some((l) => l.includes(HASH) || l.includes('$2'))).toBe(false);
      expect(lines.filter((l) => /setup code: the one printed on this device's sticker/.test(l))).toHaveLength(2);
    });
  });

  describe('admin password (system/admin)', () => {
    it('is null until written, then the password', async () => {
      const { store, kv } = makeStore();
      expect(await store.adminPassword()).toBeNull();
      await store.saveAdminPassword('correct-horse-12');
      expect(kv.get('system', 'admin')).toEqual({ password: 'correct-horse-12' });
      expect(await store.adminPassword()).toBe('correct-horse-12');
    });
  });
});
