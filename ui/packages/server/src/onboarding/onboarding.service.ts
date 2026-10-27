import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OpenBaoCasMismatchError } from '../installed/openbao.client';
import { CasdoorAdminService, type CasdoorSession } from './casdoor-admin.service';
import {
  OnboardingStore,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  STORE_UNAVAILABLE,
  type OnboardingRecord,
} from './onboarding-store';
import { setupCodeMatches } from './setup-code';

/** The account password's floor; Casdoor's set-password rejects whitespace. */
export const MIN_PASSWORD_LENGTH = 12;
/** Casdoor's own rule, lowercased: letters and digits joined by single dots or dashes. */
const USERNAME = /^(?=.{1,39}$)[a-z0-9]+([.-][a-z0-9]+)*$/;
const CHANGED_OUTSIDE = "Casdoor's admin password was changed outside LibrePod";
const RECORD_CHANGED = 'The setup changed while you were on this step — reload the page';

export function checkPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || /\s/.test(value)) {
    throw new BadRequestException(`Use at least ${MIN_PASSWORD_LENGTH} characters, without spaces`);
  }
  return value;
}

/** Claim, account and the Casdoor sync behind them (spec §8). HTTP lives in BootstrapController. */
@Injectable()
export class OnboardingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardingService.name);
  private retry?: NodeJS.Timeout;
  /** "generation:username" of users this process created, so a retry after the
   * record write failed keeps its own new user instead of calling it taken. */
  private readonly created = new Set<string>();

  constructor(
    private readonly store: OnboardingStore,
    private readonly casdoor: CasdoorAdminService,
  ) {}

  onModuleInit(): void {
    // Tier 1 forces the state and has no Casdoor.
    if (process.env.BOOTSTRAP_MODE_OVERRIDE) return;
    void this.startCasdoor();
  }

  onModuleDestroy(): void {
    clearTimeout(this.retry);
  }

  /** Brings Casdoor to the state onboarding needs (admin password, org, admins group,
   * the recorded account's membership), retrying in the background with a backoff
   * while Casdoor or OpenBao is not ready. */
  async startCasdoor(delayMs = RETRY_MIN_MS): Promise<void> {
    try {
      await this.prepareCasdoor();
    } catch (err) {
      if (err instanceof ConflictException) {
        // Retrying can't fix a password changed by hand, and each try's wrong sign-ins count
        // toward Casdoor's lockout. The Account step reports it; a restart tries again.
        this.logger.error(`${err.message}; not retrying`);
        return;
      }
      this.logger.warn(`Casdoor not ready (${(err as Error).message}); retrying in ${delayMs / 1000}s`);
      this.retry = setTimeout(() => void this.startCasdoor(Math.min(delayMs * 2, RETRY_MAX_MS)), delayMs);
      this.retry.unref();
    }
  }

  /** A built-in admin session whose password is the machine-generated one in
   * system/admin. The password goes to OpenBao first and only then to Casdoor, so a
   * crash in between leaves a stored password Casdoor will be set to on the next run.
   * Factory "123" is accepted too: a fresh Casdoor, or one reset to factory. */
  async casdoorAdmin(): Promise<CasdoorSession> {
    let stored = await this.stored(this.store.adminPassword());
    if (!stored) {
      const generated = randomBytes(16).toString('hex');
      // cas 0: of two first runs (startup and the Account step) one password wins.
      stored = await this.stored(
        this.store.saveAdminPassword(generated, { cas: 0 }).then(
          () => generated,
          (err) => {
            if (err instanceof OpenBaoCasMismatchError) return this.store.adminPassword();
            throw err;
          },
        ),
      );
      if (!stored) {
        // An entry exists but holds no password.
        await this.stored(this.store.saveAdminPassword(generated));
        stored = generated;
      }
    }
    const session = await this.casdoor.signIn([stored, this.casdoor.factoryPassword]);
    if (!session) throw new ConflictException(CHANGED_OUTSIDE);
    if (session.password !== stored) await this.casdoor.setAdminPassword(session, stored);
    return { ...session, password: stored };
  }

  /** The admin session, the org, the admins group, and the recorded account in it. */
  async prepareCasdoor(): Promise<CasdoorSession> {
    const session = await this.casdoorAdmin();
    await this.casdoor.ensureOrganization(session);
    await this.casdoor.ensureGroup(session);
    const { account } = await this.stored(this.store.record());
    // The account may have been deleted from Casdoor by hand: skip, don't retry forever.
    if (account) await this.casdoor.ensureInGroup(session, account);
    return session;
  }

  /** The setup code is the only claim credential. Open → claimed; on a claimed device
   * the right code lets another browser in without a write. */
  async claim(input: { code: unknown }, source: string): Promise<OnboardingRecord> {
    const record = await this.stored(this.store.record());
    if (record.state === 'finished') throw new ConflictException('This device is already set up');
    this.checkCode(input.code, record, source);
    if (record.state === 'claimed') {
      this.logger.log(`setup resumed from ${source}`);
      return record;
    }
    const claimed: OnboardingRecord = { ...record, state: 'claimed', claimedAt: new Date().toISOString() };
    await this.stored(this.store.save(claimed));
    this.logger.log(`device claimed from ${source}`);
    return claimed;
  }

  /** Creates the personal user, or adopts an existing one: the recorded account
   * (after a reset), or an account proven by its password — the owner's own from
   * before the record existed, or any existing one while the machine credential
   * is unusable. Someone else's user is never adopted on a username alone. */
  async account(input: { username: unknown; password?: unknown }): Promise<OnboardingRecord> {
    const username = typeof input.username === 'string' ? input.username : '';
    if (!USERNAME.test(username) || username === 'admin') {
      throw new BadRequestException('Use 1–39 lowercase letters and digits, joined by single dots or dashes — "admin" is taken');
    }
    const given = input.password;
    // Policy applies only where a password is WRITTEN: an existing account's
    // current password may predate it.
    const password = typeof given === 'string' && given !== '' ? given : null;
    const record = await this.stored(this.store.record());
    if (record.state !== 'claimed') throw new ConflictException('Claim this device first');

    // The machine credential may be unusable (changed by hand, or MFA on the
    // admin) — that only blocks creating a user, not adopting an existing one.
    let session: CasdoorSession | null = null;
    let adminBroken: string | null = null;
    try {
      session = await this.prepareCasdoor();
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
      adminBroken = err.message;
    }

    const created = `${record.generation}:${username}`;
    if (!session) {
      // No admin session: a user cannot be created and the admins group cannot be
      // checked — the first setup did both, and adopting the account trusts them.
      if (!password) {
        throw new BadRequestException(
          `A new account can't be created while the admin credential is broken — enter the password of an existing account to continue. (${adminBroken})`,
        );
      }
      if (!(await this.casdoor.userPasswordOk(username, password))) {
        throw new UnauthorizedException(
          'Wrong username or password — only an existing account can continue while the admin credential is broken',
        );
      }
    } else if (!(await this.casdoor.getUser(session, username))) {
      if (!password) throw new BadRequestException('Choose a password for the new account');
      await this.casdoor.addUser(session, username, checkPassword(password), [this.casdoor.adminsGroupId]);
      this.created.add(created);
    } else if (username !== record.account && !this.created.has(created)) {
      // An existing user the wizard has no record of: on a long-lived device that
      // is usually the owner's own account (created before the record existed);
      // after a reset it could be someone else's. Its password decides.
      if (!password) {
        throw new BadRequestException(
          'That username belongs to an existing account — enter its current password to keep it, or choose another username',
        );
      }
      if (!(await this.casdoor.userPasswordOk(username, password))) {
        throw new UnauthorizedException(
          `That password doesn't match the existing account "${username}" — choose another username`,
        );
      }
      await this.casdoor.ensureInGroup(session, username);
    } else {
      if (password) await this.casdoor.setUserPassword(session, username, checkPassword(password));
      await this.casdoor.ensureInGroup(session, username);
    }

    const next: OnboardingRecord = { ...record, account: username, accountGeneration: record.generation };
    await this.stored(this.store.save(next));
    return next;
  }

  private checkCode(code: unknown, record: OnboardingRecord, source: string): void {
    if (setupCodeMatches(code, record.code)) return;
    // The source address, never the attempted value.
    this.logger.warn(`wrong setup code from ${source}`);
    throw new ForbiddenException("That setup code isn't right");
  }

  /** OpenBao trouble is a retryable 503 for the wizard; HTTP errors pass through. A
   * record that changed since it was read (a reset, most likely) is a 409: retrying
   * the same request can't help, reloading the wizard can. */
  private async stored<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof OpenBaoCasMismatchError) throw new ConflictException(RECORD_CHANGED);
      this.logger.warn(`onboarding store: ${(err as Error).message}`);
      throw new ServiceUnavailableException(STORE_UNAVAILABLE);
    }
  }
}
