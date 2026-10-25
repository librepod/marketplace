import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnboardingService } from './onboarding.service';
import { OnboardingStore } from './onboarding-store';
import { formatSetupCode } from './setup-code';
import type { CasdoorAdminService } from './casdoor-admin.service';
import { OpenBaoUnavailableError, type OpenBaoClient } from '../installed/openbao.client';
import { FakeKv } from '../../test/fixtures/fake-kv';
import { fakeCasdoor } from '../../test/fixtures/fake-casdoor';

const RECORD = 'marketplace-ui/onboarding';
const ADMIN = 'admin-password-12';

function make(casdoorPassword = '123') {
  const kv = new FakeKv();
  const store = new OnboardingStore(kv as unknown as OpenBaoClient, new ConfigService({}));
  const { casdoor, state } = fakeCasdoor(casdoorPassword);
  const service = new OnboardingService(store, casdoor as unknown as CasdoorAdminService);
  return { kv, store, casdoor, state, service };
}

/** A device claimed and set up with `name`: its account is recorded. */
async function claimedWithAccount(name: string) {
  const t = await claimed();
  await t.service.account({ username: name, password: 'personal-pass-12' });
  return t;
}

/** A device claimed, with Casdoor's admin password already synced as at startup. */
async function claimed() {
  const t = make();
  await t.kv.writeEntry('system', 'admin', { password: ADMIN });
  await t.service.casdoorAdmin();
  await t.service.claim({ code: (await t.store.record()).code }, '10.0.0.9');
  return t;
}

describe('OnboardingService', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.BOOTSTRAP_MODE_OVERRIDE;
  });

  describe('claim', () => {
    it('open → claimed with only the code; no Casdoor and no system/admin', async () => {
      const { service, store, kv, casdoor } = make();
      const record = await service.claim({ code: (await store.record()).code }, '10.0.0.9');
      expect(record).toMatchObject({ state: 'claimed', claimedAt: expect.any(String) });
      expect(casdoor.signIn).not.toHaveBeenCalled();
      expect(kv.get('system', 'admin')).toBeUndefined();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'claimed' });
    });

    it('claimed: the right code lets another browser in, with no write', async () => {
      const t = make();
      const { code } = await t.store.record();
      const first = await t.service.claim({ code }, '10.0.0.9');
      const { version } = await t.store.record();
      const again = await t.service.claim({ code }, '10.0.0.10');
      expect(again.claimedAt).toBe(first.claimedAt);
      expect(again.version).toBe(version);
    });

    it('accepts the code typed in lowercase with dashes or spaces', async () => {
      const { service, store } = make();
      const { code } = await store.record();
      const typed = ` ${formatSetupCode(code).toLowerCase().replace('-', ' ')} `;
      await expect(service.claim({ code: typed }, '10.0.0.9')).resolves.toMatchObject({ state: 'claimed' });
    });

    it('a wrong code is a 403 that changes nothing and logs the source, never the attempt', async () => {
      const { service, kv } = make();
      await expect(service.claim({ code: 'AAAA-BBBB-CCCC' }, '10.0.0.9')).rejects.toThrow(
        new ForbiddenException("That setup code isn't right"),
      );
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open' });
      expect(warn).toHaveBeenCalledWith('wrong setup code from 10.0.0.9');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('AAAA');
    });

    it('a wrong code on a claimed device is a 403 too', async () => {
      const t = await claimed();
      await expect(t.service.claim({ code: 'AAAA-BBBB-CCCC' }, '10.0.0.9')).rejects.toThrow(ForbiddenException);
    });

    it('finished is a 409', async () => {
      const t = await claimedWithAccount('alex');
      const { code } = await t.store.record();
      await t.store.finishIfClaimed('alex');
      await expect(t.service.claim({ code }, '10.0.0.9')).rejects.toThrow(
        new ConflictException('This device is already set up'),
      );
    });

    it('OpenBao down is a 503', async () => {
      const down = make();
      down.kv.failWith = new OpenBaoUnavailableError('sealed');
      await expect(down.service.claim({ code: 'X' }, '10.0.0.9')).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe('casdoorAdmin / prepareCasdoor', () => {
    it('fresh device: stores a generated password BEFORE changing Casdoor, then uses it', async () => {
      const { service, kv, casdoor, state } = make();
      const order: string[] = [];
      const write = kv.writeEntry.bind(kv);
      vi.spyOn(kv, 'writeEntry').mockImplementation(async (...a) => {
        order.push(`write:${a[1]}`);
        return write(...a);
      });
      casdoor.setAdminPassword.mockImplementationOnce(async (_s, p) => {
        order.push('casdoor');
        state.adminPassword = p;
      });
      const session = await service.casdoorAdmin();
      const stored = kv.get('system', 'admin')?.password;
      expect(stored).toMatch(/^[0-9a-f]{32}$/);
      expect(state.adminPassword).toBe(stored);
      expect(session.cookie).toBeTruthy();
      expect(order).toEqual(['write:admin', 'casdoor']);
    });

    it('stored password accepted: no change to Casdoor', async () => {
      const t = make('stored-0123456789');
      await t.kv.writeEntry('system', 'admin', { password: 'stored-0123456789' });
      await t.service.casdoorAdmin();
      expect(t.casdoor.setAdminPassword).not.toHaveBeenCalled();
    });

    it('Casdoor reset to factory while OpenBao kept the password: sets the stored one back', async () => {
      const t = make('123');
      await t.kv.writeEntry('system', 'admin', { password: 'stored-0123456789' });
      await t.service.casdoorAdmin();
      expect(t.state.adminPassword).toBe('stored-0123456789');
      expect(t.kv.get('system', 'admin')).toEqual({ password: 'stored-0123456789' });
    });

    it('neither password accepted: 409 changed outside, nothing rewritten', async () => {
      const t = make('someone-elses-pw');
      await t.kv.writeEntry('system', 'admin', { password: 'stored-0123456789' });
      await expect(t.service.casdoorAdmin()).rejects.toThrow(
        new ConflictException("Casdoor's admin password was changed outside LibrePod"),
      );
      expect(t.kv.get('system', 'admin')).toEqual({ password: 'stored-0123456789' });
    });

    it('two concurrent first runs agree on one password (cas 0 race is not a "reload" 409)', async () => {
      const t = make();
      const [a, b] = await Promise.all([t.service.casdoorAdmin(), t.service.casdoorAdmin()]);
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(t.state.adminPassword).toBe(t.kv.get('system', 'admin')?.password);
    });

    it('Casdoor down: 503 and system/admin keeps the first generated value for the retry', async () => {
      const t = make();
      t.casdoor.signIn.mockRejectedValueOnce(new ServiceUnavailableException('down'));
      await expect(t.service.casdoorAdmin()).rejects.toThrow(ServiceUnavailableException);
      const first = t.kv.get('system', 'admin')?.password;
      await t.service.casdoorAdmin();
      expect(t.kv.get('system', 'admin')?.password).toBe(first);
    });

    it("startCasdoor stops retrying when Casdoor's admin password was changed outside: retries would trip its lockout", async () => {
      vi.useFakeTimers();
      const t = make('someone-elses-pw');
      await t.kv.writeEntry('system', 'admin', { password: 'stored-0123456789' });
      await t.service.startCasdoor();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(t.casdoor.signIn).toHaveBeenCalledTimes(1);
    });

    it('prepareCasdoor: org, group, and the recorded account joins admins', async () => {
      const t = await claimedWithAccount('owner');
      t.state.admins.clear();
      await t.service.prepareCasdoor();
      expect(t.casdoor.ensureOrganization).toHaveBeenCalled();
      expect(t.state.groupExists).toBe(true);
      expect(t.state.admins.has('owner')).toBe(true);
    });

    it('prepareCasdoor resolves when the recorded account was deleted from Casdoor', async () => {
      const t = await claimedWithAccount('owner');
      t.state.users.delete('owner');
      await expect(t.service.prepareCasdoor()).resolves.toBeTruthy();
    });

    it('startCasdoor retries with backoff until prepareCasdoor succeeds; skipped under BOOTSTRAP_MODE_OVERRIDE', async () => {
      vi.useFakeTimers();
      const t = make();
      t.casdoor.signIn.mockRejectedValueOnce(new ServiceUnavailableException('down'));
      await t.service.startCasdoor();
      expect(t.state.groupExists).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(t.state.groupExists).toBe(true);
      vi.useRealTimers();
      process.env.BOOTSTRAP_MODE_OVERRIDE = 'open';
      const u = make();
      u.service.onModuleInit();
      expect(u.casdoor.signIn).not.toHaveBeenCalled();
    });
  });

  describe('account', () => {
    it('creates the personal user and records it for this generation', async () => {
      const t = await claimed();
      const record = await t.service.account({ username: 'alex', password: 'personal-pass-12' });
      expect(t.state.users.get('alex')).toBe('personal-pass-12');
      expect(t.state.admins.has('alex')).toBe(true);
      expect(record).toMatchObject({ account: 'alex', accountGeneration: record.generation });
      expect(t.kv.get('system', RECORD)).toMatchObject({ account: 'alex', accountGeneration: 1 });
    });

    /** Set up as alex, then reset and re-claimed: the Account step offers "keep alex". */
    async function afterReset() {
      const t = await claimed();
      await t.service.account({ username: 'alex', password: 'forgotten-pass-12' });
      const code = await t.store.reset();
      await t.service.claim({ code }, '10.0.0.9');
      vi.clearAllMocks();
      return t;
    }

    it('after a reset, the kept account stays as is without a password, or is re-passworded with one', async () => {
      const t = await afterReset();
      await t.service.account({ username: 'alex' });
      expect(t.casdoor.ensureInGroup).toHaveBeenCalledWith(expect.anything(), 'alex');
      expect(t.casdoor.addUser).not.toHaveBeenCalled();
      expect(t.casdoor.setUserPassword).not.toHaveBeenCalled();
      await t.service.account({ username: 'alex', password: 'brand-new-pass-12' });
      expect(t.state.users.get('alex')).toBe('brand-new-pass-12');
    });

    it("after a reset, someone else's existing name is a 409 that leaves their password alone", async () => {
      const t = await afterReset();
      t.state.users.set('sam', 'sams-own-pass-12');
      await expect(t.service.account({ username: 'sam', password: 'owner-typed-12' })).rejects.toThrow(
        new ConflictException('That username is already taken — choose another'),
      );
      expect(t.state.users.get('sam')).toBe('sams-own-pass-12');
      expect(t.kv.get('system', RECORD)).toMatchObject({ account: 'alex' });
    });

    it('a retry after the record write failed keeps the user it just created', async () => {
      const t = await claimed();
      vi.spyOn(t.store, 'save').mockRejectedValueOnce(new OpenBaoUnavailableError('sealed'));
      await expect(t.service.account({ username: 'alex', password: 'personal-pass-12' })).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(t.state.users.get('alex')).toBe('personal-pass-12');
      await expect(t.service.account({ username: 'alex', password: 'personal-pass-12' })).resolves.toMatchObject({
        account: 'alex',
      });
    });

    it('a reset since the record was read is a 409 to reload, and the reset stands', async () => {
      const t = await claimed();
      const cli = new OnboardingStore(t.kv as unknown as OpenBaoClient, new ConfigService({}));
      const code = await cli.reset();
      await expect(t.service.account({ username: 'alex', password: 'personal-pass-12' })).rejects.toThrow(
        new ConflictException('The setup changed while you were on this step — reload the page'),
      );
      expect(t.kv.get('system', RECORD)).toMatchObject({ state: 'open', code, generation: 2, account: null });
    });

    it('a new user needs a password', async () => {
      const t = await claimed();
      await expect(t.service.account({ username: 'alex' })).rejects.toThrow(
        new BadRequestException('Choose a password for the new account'),
      );
    });

    it('usernames: lowercase letters and digits joined by single dots or dashes, 1–39 characters, never admin', async () => {
      const t = await claimed();
      for (const username of ['Alex', 'admin', '', 'a'.repeat(40), 'al ex', 'al_ex', 'al@ex', 'alex.', '-alex', 'a..b', 'a.-b', 42, undefined]) {
        await expect(t.service.account({ username, password: 'personal-pass-12' })).rejects.toThrow(BadRequestException);
      }
      expect(t.casdoor.addUser).not.toHaveBeenCalled();
      await expect(t.service.account({ username: 'a.l-ex9', password: 'personal-pass-12' })).resolves.toBeDefined();
    });

    it('a weak personal password is a 400', async () => {
      const t = await claimed();
      await expect(t.service.account({ username: 'alex', password: 'short' })).rejects.toThrow(BadRequestException);
    });

    it('no stored admin password: generates one instead of failing', async () => {
      const t = make(); // Casdoor still at factory
      await t.store.save({ ...(await t.store.record()), state: 'claimed' });
      await t.kv.writeEntry('system', 'admin', {});
      await expect(t.service.account({ username: 'alex', password: 'personal-pass-12' })).resolves.toBeDefined();
      expect(t.kv.get('system', 'admin')?.password).toBeTruthy();
    });
  });
});
