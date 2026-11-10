import { readFile } from 'node:fs/promises';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenBaoCasMismatchError, OpenBaoClient } from '../installed/openbao.client';
import { formatSetupCode, generateSetupCode, isSetupCode, normalizeSetupCode } from './setup-code';

export type StoredState = 'open' | 'claimed' | 'finished';

/** system/marketplace-ui/onboarding. `accountGeneration` is the generation in which
 * the Account step last ran: a reset keeps `account` (so the wizard can offer "keep
 * alex") but the step runs again after every claim. */
export interface OnboardingRecord {
  state: StoredState;
  code: string;
  generation: number;
  account: string | null;
  accountGeneration: number | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  /** The KV version this record was read at — save()'s check-and-set. Not stored. */
  version: number;
}

type StoredRecord = Omit<OnboardingRecord, 'version'>;

export const STORE_UNAVAILABLE = "LibrePod's secret store isn't reachable right now — try again in a minute.";

const RECORD_PATH = 'marketplace-ui/onboarding';
const ADMIN_PATH = 'admin';
/** reset-onboarding is another process: the server sees its write within this. */
const CACHE_TTL_MS = 5_000;
export const RETRY_MIN_MS = 5_000;
export const RETRY_MAX_MS = 60_000;
/** How often logSetupCode() may repeat a code — the wizard polls status every 4s. */
const CODE_LOG_THROTTLE_MS = 60_000;
const STATES: readonly StoredState[] = ['open', 'claimed', 'finished'];

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export function parseRecord(data: Record<string, unknown>, version: number): OnboardingRecord {
  const state = data.state as StoredState;
  const code = text(data.code);
  const generation = count(data.generation);
  if (!STATES.includes(state) || !code || generation === null) {
    throw new Error('the onboarding record is malformed — run reset-onboarding');
  }
  return {
    state,
    code,
    generation,
    account: text(data.account),
    accountGeneration: count(data.accountGeneration),
    createdAt: text(data.createdAt) ?? '',
    claimedAt: text(data.claimedAt),
    finishedAt: text(data.finishedAt),
    version,
  };
}

/**
 * First-run onboarding state in OpenBao `system/` (spec §6–§7): the onboarding
 * record, and Casdoor's machine-generated admin password stored readable by design (LibrePod is a trusted
 * perimeter). The record is created on first start with check-and-set, and the
 * setup code is logged on every start until onboarding finishes.
 */
@Injectable()
export class OnboardingStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardingStore.name);
  private cached?: { record: OnboardingRecord; at: number };
  private finished = false;
  private retry?: NodeJS.Timeout;
  private codeLogged?: { code: string; at: number };

  constructor(
    private readonly bao: OpenBaoClient,
    private readonly config: ConfigService,
  ) {}

  private get mount(): string {
    return this.config.get<string>('OPENBAO_SYSTEM_MOUNT', 'system');
  }

  onModuleInit(): void {
    // Tier 1 forces the state and its dev-mode OpenBao has no system/ mount.
    if (process.env.BOOTSTRAP_MODE_OVERRIDE) return;
    void this.start();
  }

  onModuleDestroy(): void {
    clearTimeout(this.retry);
  }

  /** Ensures the record exists and logs the setup code; retries in the background
   * (backing off to a minute) while OpenBao is not ready. */
  async start(delayMs = RETRY_MIN_MS): Promise<void> {
    try {
      const record = await this.ensure();
      if (record.state !== 'finished') this.logCode(record.code);
    } catch (err) {
      this.logger.warn(`onboarding record not ready (${(err as Error).message}); retrying in ${delayMs / 1000}s`);
      this.retry = setTimeout(() => void this.start(Math.min(delayMs * 2, RETRY_MAX_MS)), delayMs);
      this.retry.unref();
    }
  }

  /** A browser entered the wizard without a setup session — the claim screen, where
   * the code is needed. The start-time line may have scrolled out of the pod's log,
   * or a reset-onboarding run while this pod was up replaced the code without it ever
   * being logged here, so re-log it: the wizard's "grep the logs" hint must answer.
   * At most once a minute per code; a new code logs immediately. */
  logSetupCode(record: OnboardingRecord): void {
    if (record.state === 'finished') return;
    if (this.codeLogged?.code === record.code && Date.now() - this.codeLogged.at < CODE_LOG_THROTTLE_MS) return;
    this.codeLogged = { code: record.code, at: Date.now() };
    this.logCode(record.code);
  }

  /** The current record, at most CACHE_TTL_MS old. Throws when OpenBao can't answer. */
  async record(): Promise<OnboardingRecord> {
    if (this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) return this.cached.record;
    return this.ensure();
  }

  /** Whether the last record this process read or saved was `finished`. Unlike the
   * cache it doesn't expire: status answers with it while OpenBao can't. */
  get knownFinished(): boolean {
    return this.finished;
  }

  /** Check-and-set against the version the record was read at: a record read before
   * someone else's write (a reset by the CLI, a concurrent request) fails with
   * OpenBaoCasMismatchError instead of undoing that write. */
  async save(record: OnboardingRecord): Promise<void> {
    const { version, ...data } = record;
    await this.write(data, version);
    this.remember({ ...record, version: version + 1 });
  }

  /** The SSO callback's hook (spec §8): the recorded account's first sign-in since the
   * claim finishes onboarding. Only that account: once there are more users, any of them
   * signing in after a reset would otherwise end the reopened wizard. A session from
   * before a reset must not either, so the sign-in has to be at or after `claimedAt`. */
  async finishIfClaimed(username: string, signedInAtMs = Date.now()): Promise<boolean> {
    const record = await this.record();
    if (record.state !== 'claimed') return false;
    if (record.account === null || username !== record.account) return false;
    if (record.claimedAt && signedInAtMs < Date.parse(record.claimedAt)) return false;
    await this.save({ ...record, state: 'finished', finishedAt: new Date().toISOString() });
    this.logger.log('onboarding finished: first single sign-on since the claim');
    return true;
  }

  /** `reset-onboarding` (spec §6): a new code — or the device code, which never changes —
   * state open, generation + 1. Keeps the account; clears claimedAt/finishedAt. Also
   * repairs a missing or malformed record. The operator's command wins whatever the
   * record holds: no check-and-set. */
  async reset(): Promise<string> {
    const device = await this.deviceCode();
    const old = (await this.bao.readEntry(this.mount, RECORD_PATH))?.data ?? {};
    const record: StoredRecord = {
      state: 'open',
      code: device ?? generateSetupCode(),
      generation: (count(old.generation) ?? 0) + 1,
      account: text(old.account),
      accountGeneration: count(old.accountGeneration),
      createdAt: text(old.createdAt) ?? new Date().toISOString(),
      claimedAt: null,
      finishedAt: null,
    };
    await this.write(record);
    return record.code;
  }

  async adminPassword(): Promise<string | null> {
    const password = (await this.bao.readEntry(this.mount, ADMIN_PATH))?.data.password;
    return typeof password === 'string' && password !== '' ? password : null;
  }

  /** `cas: 0` creates it only if nothing is stored yet. */
  async saveAdminPassword(password: string, opts: { cas?: number } = {}): Promise<void> {
    await this.bao.writeEntry(this.mount, ADMIN_PATH, { password }, opts);
  }

  /** Reads the record, creating it when missing: open, the device code or a fresh one,
   * generation 1. Check-and-set (cas 0), so two pods starting together cannot both
   * create a code. An open record takes the device code whenever it arrives — the pod
   * may start before LibrePod OS published it — so an open device always answers to
   * its sticker; a claimed or finished one is never changed. */
  private async ensure(): Promise<OnboardingRecord> {
    const device = await this.deviceCode();
    const existing = await this.read();
    if (existing && device && existing.state === 'open' && existing.code !== device) {
      try {
        await this.save({ ...existing, code: device });
      } catch (err) {
        if (!(err instanceof OpenBaoCasMismatchError)) throw err;
        return this.ensure(); // written meanwhile: decide again on what is there now
      }
      return { ...existing, code: device, version: existing.version + 1 };
    }
    if (existing) return existing;
    const now = new Date().toISOString();
    const fresh: OnboardingRecord = {
      state: 'open', code: device ?? generateSetupCode(), generation: 1, account: null, accountGeneration: null,
      createdAt: now, claimedAt: null, finishedAt: null, version: 0,
    };
    try {
      await this.save(fresh);
    } catch (err) {
      if (!(err instanceof OpenBaoCasMismatchError)) throw err;
      const winner = await this.read();
      if (!winner) throw err;
      return winner;
    }
    return { ...fresh, version: 1 };
  }

  /** The code LibrePod OS provisioned for this device (printed on its sticker), from the
   * optional Secret mount; null on any other cluster or before the Secret exists. A file
   * that is not a setup code throws: a random code would silently stop matching the sticker. */
  private async deviceCode(): Promise<string | null> {
    const file = this.config.get<string>('SETUP_CODE_FILE');
    if (!file) return null;
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const code = normalizeSetupCode(raw);
    if (!isSetupCode(code)) {
      throw new Error(`${file} is not a setup code — check /var/lib/librepod/setup-code on the device`);
    }
    return code;
  }

  private async read(): Promise<OnboardingRecord | null> {
    const entry = await this.bao.readEntry(this.mount, RECORD_PATH);
    if (!entry) return null;
    const record = parseRecord(entry.data, entry.version);
    this.remember(record);
    return record;
  }

  /** Drops the cache first: whatever the outcome — a failed write may still have
   * landed — the next read is fresh unless save() caches what it wrote. */
  private async write(data: StoredRecord, cas?: number): Promise<void> {
    this.cached = undefined;
    await this.bao.writeEntry(this.mount, RECORD_PATH, { ...data }, cas === undefined ? {} : { cas });
  }

  private remember(record: OnboardingRecord): void {
    this.cached = { record, at: Date.now() };
    this.finished = record.state === 'finished';
  }

  private logCode(code: string): void {
    this.logger.log(
      `LibrePod setup code: ${formatSetupCode(code)} — open http://<this device's IP> to set up`,
    );
  }
}
