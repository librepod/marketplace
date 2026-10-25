import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenBaoCasMismatchError, OpenBaoClient } from '../installed/openbao.client';
import { formatSetupCode, generateSetupCode } from './setup-code';

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
 * record, and the admin password stored readable by design (LibrePod is a trusted
 * perimeter). The record is created on first start with check-and-set, and the
 * setup code is logged on every start until onboarding finishes.
 */
@Injectable()
export class OnboardingStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnboardingStore.name);
  private cached?: { record: OnboardingRecord; at: number };
  private finished = false;
  private retry?: NodeJS.Timeout;

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
      if (record.state !== 'finished') {
        this.logger.log(
          `LibrePod setup code: ${formatSetupCode(record.code)} — open http://<this device's IP> to set up`,
        );
      }
    } catch (err) {
      this.logger.warn(`onboarding record not ready (${(err as Error).message}); retrying in ${delayMs / 1000}s`);
      this.retry = setTimeout(() => void this.start(Math.min(delayMs * 2, RETRY_MAX_MS)), delayMs);
      this.retry.unref();
    }
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

  /** `reset-onboarding` (spec §6): a new code, state open, generation + 1. Keeps the
   * account; clears claimedAt/finishedAt. Also repairs a missing or malformed record.
   * The operator's command wins whatever the record holds: no check-and-set. */
  async reset(): Promise<string> {
    const old = (await this.bao.readEntry(this.mount, RECORD_PATH))?.data ?? {};
    const record: StoredRecord = {
      state: 'open',
      code: generateSetupCode(),
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

  /** Reads the record, creating it when missing: open, a fresh code, generation 1.
   * Check-and-set (cas 0), so two pods starting together cannot both create a code. */
  private async ensure(): Promise<OnboardingRecord> {
    const existing = await this.read();
    if (existing) return existing;
    const now = new Date().toISOString();
    const fresh: OnboardingRecord = {
      state: 'open', code: generateSetupCode(), generation: 1, account: null, accountGeneration: null,
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
}
