import * as crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Mutex } from 'async-mutex';

/** No 0/O and no 1/I/L: a code read off a log or a screen is typed without guessing. */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 31^12 ≈ 2^59 — guessing over the network is not realistic, so attempts are not rate-limited. */
export const SETUP_CODE_LENGTH = 12;

/** A fresh setup code, stored and compared without dashes. */
export function generateSetupCode(
  randomInt: (max: number) => number = crypto.randomInt,
): string {
  let code = '';
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) {
    code += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  }
  return code;
}

/** 7KQMX3RT9VHC → 7KQM-X3RT-9VHC */
export function formatSetupCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** What a person typed → the stored form: upper-cased, dashes and whitespace removed. */
export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** The Device's setup-code hash: what LibrePod OS publishes instead of the sticker code. */
export const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
export function isBcryptHash(s: string): boolean {
  return BCRYPT_HASH.test(s);
}

// /claim is public and not rate-limited; a cost-12 compare is ~0.25 s of pure-JS CPU,
// so compares queue instead of pinning the CPU.
const compareLock = new Mutex();

/** Compares a typed code with the stored one: a bcrypt hash (the sticker's code) or a
 * minted code (constant-time; hashing first makes the lengths equal, which
 * timingSafeEqual requires). */
export async function setupCodeMatches(
  input: unknown,
  stored: string,
): Promise<boolean> {
  if (typeof input !== 'string') return false;
  const typed = normalizeSetupCode(input);
  if (isBcryptHash(stored))
    return compareLock.runExclusive(() => bcrypt.compare(typed, stored));
  const a = crypto.createHash('sha256').update(typed).digest();
  const b = crypto.createHash('sha256').update(stored).digest();
  return crypto.timingSafeEqual(a, b);
}
