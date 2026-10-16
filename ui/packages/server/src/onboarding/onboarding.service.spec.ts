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

/** A device claimed with ADMIN, as after a successful claim. */
async function claimed() {
  const t = make();
  await t.service.claim({ code: (await t.store.record()).code, password: ADMIN }, '10.0.0.9');
  return t;
}

describe('OnboardingService', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  describe('claim', () => {
    it('with the factory password: sets the admin password, stores it, ensures the org, records claimed', async () => {
      const { service, store, kv, casdoor, state } = make();
      const { code } = await store.record();
      const record = await service.claim({ code, password: ADMIN }, '10.0.0.9');
      expect(record).toMatchObject({ state: 'claimed', claimedAt: expect.any(String) });
      expect(state.adminPassword).toBe(ADMIN);
      expect(kv.get('system', 'admin')).toEqual({ password: ADMIN });
      expect(casdoor.ensureOrganization).toHaveBeenCalledOnce();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'claimed' });
    });

    it('accepts the code typed in lowercase with dashes or spaces', async () => {
      const { service, store } = make();
      const { code } = await store.record();
      const typed = ` ${formatSetupCode(code).toLowerCase().replace('-', ' ')} `;
      await expect(service.claim({ code: typed, password: ADMIN }, '10.0.0.9')).resolves.toMatchObject({ state: 'claimed' });
    });

    it('a wrong code is a 403 that changes nothing and logs the source, never the attempt', async () => {
      const { service, kv, state } = make();
      await expect(service.claim({ code: 'AAAA-BBBB-CCCC', password: ADMIN }, '10.0.0.9')).rejects.toThrow(
        new ForbiddenException("That setup code isn't right"),
      );
      expect(state.adminPassword).toBe('123');
      expect(kv.get('system', 'admin')).toBeUndefined();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open' });
      expect(warn).toHaveBeenCalledWith('wrong setup code from 10.0.0.9');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('AAAA');
    });

    it('a weak or non-text password is a 400 after the code check, before Casdoor', async () => {
      const { service, store, casdoor } = make();
      const { code } = await store.record();
      for (const password of ['elevenchars', 'has space 12345', 123456789012, undefined]) {
        await expect(service.claim({ code, password }, '10.0.0.9')).rejects.toThrow(BadRequestException);
      }
      expect(casdoor.signIn).not.toHaveBeenCalled();
    });

    it('a retry after a crash between set-password and the OpenBao write signs in with the new password', async () => {
      const { service, store, kv, casdoor } = make(ADMIN); // Casdoor already has it; system/admin does not
      const { code } = await store.record();
      await service.claim({ code, password: ADMIN }, '10.0.0.9');
      expect(casdoor.setAdminPassword).not.toHaveBeenCalled();
      expect(kv.get('system', 'admin')).toEqual({ password: ADMIN });
    });

    it('after a reset: signs in with the stored admin password and replaces it', async () => {
      const t = await claimed();
      const code = await t.store.reset();
      await t.service.claim({ code, password: 'new-admin-pass-12' }, '10.0.0.9');
      expect(t.casdoor.signIn).toHaveBeenLastCalledWith([ADMIN, '123', 'new-admin-pass-12']);
      expect(t.state.adminPassword).toBe('new-admin-pass-12');
      expect(t.kv.get('system', 'admin')).toEqual({ password: 'new-admin-pass-12' });
    });

    it('Casdoor accepting none of the passwords is a 409 that writes nothing', async () => {
      const { service, store, kv } = make('changed-by-hand-1');
      const { code } = await store.record();
      await expect(service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(
        new ConflictException("Casdoor's admin password was changed outside LibrePod"),
      );
      expect(kv.get('system', 'admin')).toBeUndefined();
      expect(kv.get('system', RECORD)).toMatchObject({ state: 'open' });
    });

    it('already claimed or finished is a 409', async () => {
      const t = await claimed();
      const { code } = await t.store.record();
      await expect(t.service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(ConflictException);
      await t.store.finishIfClaimed();
      await expect(t.service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(ConflictException);
    });

    it('OpenBao down is a 503; Casdoor down is a 503 that leaves the record open', async () => {
      const down = make();
      down.kv.failWith = new OpenBaoUnavailableError('sealed');
      await expect(down.service.claim({ code: 'X', password: ADMIN }, '10.0.0.9')).rejects.toThrow(
        ServiceUnavailableException,
      );

      const t = make();
      const { code } = await t.store.record();
      t.casdoor.signIn.mockRejectedValueOnce(new ServiceUnavailableException('casdoor down'));
      await expect(t.service.claim({ code, password: ADMIN }, '10.0.0.9')).rejects.toThrow(ServiceUnavailableException);
      expect(t.kv.get('system', RECORD)).toMatchObject({ state: 'open' });
    });
  });

  describe('resume', () => {
    it('the right code returns the claimed record; a wrong one is a 403', async () => {
      const t = await claimed();
      const { code } = await t.store.record();
      await expect(t.service.resume(code, '10.0.0.9')).resolves.toMatchObject({ state: 'claimed' });
      await expect(t.service.resume('AAAA-BBBB-CCCC', '10.0.0.9')).rejects.toThrow(ForbiddenException);
    });

    it('open or finished is a 409', async () => {
      const t = make();
      const { code } = await t.store.record();
      await expect(t.service.resume(code, '10.0.0.9')).rejects.toThrow(ConflictException);
      const c = await claimed();
      await c.store.finishIfClaimed();
      await expect(c.service.resume((await c.store.record()).code, '10.0.0.9')).rejects.toThrow(ConflictException);
    });
  });

  describe('account', () => {
    it('creates the personal user and records it for this generation', async () => {
      const t = await claimed();
      const record = await t.service.account({ username: 'alex', password: 'personal-pass-12' });
      expect(t.state.users.get('alex')).toBe('personal-pass-12');
      expect(record).toMatchObject({ account: 'alex', accountGeneration: record.generation });
      expect(t.kv.get('system', RECORD)).toMatchObject({ account: 'alex', accountGeneration: 1 });
    });

    /** Set up as alex, then reset and re-claimed: the Account step offers "keep alex". */
    async function afterReset() {
      const t = await claimed();
      await t.service.account({ username: 'alex', password: 'forgotten-pass-12' });
      const code = await t.store.reset();
      await t.service.claim({ code, password: ADMIN }, '10.0.0.9');
      vi.clearAllMocks();
      return t;
    }

    it('after a reset, the kept account stays as is without a password, or is re-passworded with one', async () => {
      const t = await afterReset();
      await t.service.account({ username: 'alex' });
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

    it('no stored admin password is a 503', async () => {
      const t = await claimed();
      await t.kv.writeEntry('system', 'admin', {});
      await expect(t.service.account({ username: 'alex', password: 'personal-pass-12' })).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
