import * as crypto from 'node:crypto';

/** No 0/O and no 1/I/L: a code read off a log or a screen is typed without guessing. */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 31^12 ≈ 2^59 — guessing over the network is not realistic, so attempts are not rate-limited. */
export const SETUP_CODE_LENGTH = 12;

/** A fresh setup code, stored and compared without dashes. */
export function generateSetupCode(randomInt: (max: number) => number = crypto.randomInt): string {
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

/** Constant-time comparison of a typed code with the stored one (hashing first
 * makes the lengths equal, which timingSafeEqual requires). */
export function setupCodeMatches(input: unknown, code: string): boolean {
  if (typeof input !== 'string') return false;
  const typed = crypto.createHash('sha256').update(normalizeSetupCode(input)).digest();
  const stored = crypto.createHash('sha256').update(code).digest();
  return crypto.timingSafeEqual(typed, stored);
}
