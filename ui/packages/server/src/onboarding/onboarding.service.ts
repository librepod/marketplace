import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CasdoorAdminService } from './casdoor-admin.service';
import { OnboardingStore, STORE_UNAVAILABLE, type OnboardingRecord } from './onboarding-store';
import { setupCodeMatches } from './setup-code';

/** wg-easy rejects shorter admin passwords at login; Casdoor's set-password rejects whitespace. */
export const MIN_PASSWORD_LENGTH = 12;
const USERNAME = /^[a-z0-9.-]{1,39}$/;
const CHANGED_OUTSIDE = "Casdoor's admin password was changed outside LibrePod";

export function checkPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || /\s/.test(value)) {
    throw new BadRequestException(`Use at least ${MIN_PASSWORD_LENGTH} characters, without spaces`);
  }
  return value;
}

/** Claim, resume and account (spec §8). HTTP lives in BootstrapController. */
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly store: OnboardingStore,
    private readonly casdoor: CasdoorAdminService,
  ) {}

  /** Every step is idempotent, so a failed claim is simply retried. */
  async claim(input: { code: unknown; password: unknown }, source: string): Promise<OnboardingRecord> {
    const record = await this.stored(this.store.record());
    if (record.state === 'claimed') {
      throw new ConflictException('This device is already claimed — enter the setup code to continue');
    }
    if (record.state === 'finished') throw new ConflictException('This device is already set up');
    this.checkCode(input.code, record, source);
    const password = checkPassword(input.password);

    // The stored admin password (present after a reset), the factory one, or the new
    // one itself — the last makes a retry after a crash between set-password and the
    // OpenBao write below succeed.
    const stored = await this.stored(this.store.adminPassword());
    const session = await this.casdoor.signIn([stored ?? '', this.casdoor.factoryPassword, password]);
    if (!session) throw new ConflictException(CHANGED_OUTSIDE);
    if (session.password !== password) await this.casdoor.setAdminPassword(session, password);
    await this.stored(this.store.saveAdminPassword(password));
    await this.casdoor.ensureOrganization(session);

    const claimed: OnboardingRecord = { ...record, state: 'claimed', claimedAt: new Date().toISOString() };
    await this.stored(this.store.save(claimed));
    this.logger.log(`device claimed from ${source}`);
    return claimed;
  }

  async resume(code: unknown, source: string): Promise<OnboardingRecord> {
    const record = await this.stored(this.store.record());
    if (record.state === 'open') throw new ConflictException('This device is not claimed yet — claim it with the setup code');
    if (record.state === 'finished') throw new ConflictException('This device is already set up');
    this.checkCode(code, record, source);
    return record;
  }

  /** Creates the personal user, or keeps an existing one (after a reset), setting a
   * new password when one is given — the recovery for a forgotten personal password. */
  async account(input: { username: unknown; password?: unknown }): Promise<OnboardingRecord> {
    const username = typeof input.username === 'string' ? input.username : '';
    if (!USERNAME.test(username) || username === 'admin') {
      throw new BadRequestException('Use 1–39 lowercase letters, digits, dots or dashes — "admin" is taken');
    }
    const given = input.password;
    const password = given === undefined || given === null || given === '' ? null : checkPassword(given);
    const record = await this.stored(this.store.record());
    if (record.state !== 'claimed') throw new ConflictException('Claim this device first');

    const session = await this.casdoor.signIn([await this.adminPassword()]);
    if (!session) throw new ConflictException(CHANGED_OUTSIDE);
    if (!(await this.casdoor.getUser(session, username))) {
      if (!password) throw new BadRequestException('Choose a password for the new account');
      await this.casdoor.addUser(session, username, password);
    } else if (password) {
      await this.casdoor.setUserPassword(session, username, password);
    }

    const next: OnboardingRecord = { ...record, account: username, accountGeneration: record.generation };
    await this.stored(this.store.save(next));
    return next;
  }

  /** The admin password from system/admin. */
  async adminPassword(): Promise<string> {
    const password = await this.stored(this.store.adminPassword());
    if (!password) throw new ServiceUnavailableException("The admin password isn't available — try again in a minute.");
    return password;
  }

  private checkCode(code: unknown, record: OnboardingRecord, source: string): void {
    if (setupCodeMatches(code, record.code)) return;
    // The source address, never the attempted value.
    this.logger.warn(`wrong setup code from ${source}`);
    throw new ForbiddenException("That setup code isn't right");
  }

  /** OpenBao trouble is a retryable 503 for the wizard; HTTP errors pass through. */
  private async stored<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`onboarding store: ${(err as Error).message}`);
      throw new ServiceUnavailableException(STORE_UNAVAILABLE);
    }
  }
}
