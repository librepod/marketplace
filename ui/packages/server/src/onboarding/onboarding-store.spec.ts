import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingStore } from './onboarding-store';
import { SETUP_CODE_ALPHABET, formatSetupCode } from './setup-code';
import { OpenBaoCasMismatchError, OpenBaoUnavailableError, type OpenBaoClient } from '../installed/openbao.client';
import { FakeKv } from '../../test/fixtures/fake-kv';

const RECORD = 'marketplace-ui/onboarding';

function makeStore(kv = new FakeKv(), env: Record<string, string> = {}) {
  return { store: new OnboardingStore(kv as unknown as OpenBaoClient, new ConfigService(env)), kv };
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
      expect(await store.finishIfClaimed()).toBe(false);
      await store.save({ ...open, state: 'claimed', claimedAt: '2026-10-14T10:00:00.000Z' });
      expect(await store.finishIfClaimed()).toBe(true);
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'finished', finishedAt: expect.any(String) });
      expect(await store.finishIfClaimed()).toBe(false);
    });

    it('only a sign-in since the claim finishes — an older session must not end a reopened wizard', async () => {
      const { store } = makeStore();
      const open = await store.record();
      const claimedAt = Date.parse('2026-10-14T10:00:00.000Z');
      await store.save({ ...open, state: 'claimed', claimedAt: new Date(claimedAt).toISOString() });
      expect(await store.finishIfClaimed(claimedAt - 1_000)).toBe(false);
      expect(await store.finishIfClaimed(claimedAt + 1_000)).toBe(true);
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
