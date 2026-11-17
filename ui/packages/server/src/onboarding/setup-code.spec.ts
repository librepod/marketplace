import { describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  SETUP_CODE_ALPHABET,
  formatSetupCode,
  generateSetupCode,
  isBcryptHash,
  normalizeSetupCode,
  setupCodeMatches,
} from './setup-code';

describe('setup code', () => {
  it('is 12 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSetupCode()).toMatch(
        /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/,
      );
    }
  });

  it('the alphabet has no 0/O or 1/I/L — 31 characters, about 59 bits for 12', () => {
    expect(SETUP_CODE_ALPHABET).not.toMatch(/[0O1IL]/);
    expect(SETUP_CODE_ALPHABET).toHaveLength(31);
  });

  it('draws every character from the random source over the whole alphabet', () => {
    const bounds: number[] = [];
    const code = generateSetupCode((max) => {
      bounds.push(max);
      return 0;
    });
    expect(bounds).toEqual(Array(12).fill(31));
    expect(code).toBe('AAAAAAAAAAAA');
  });

  it('formats as three groups of four', () => {
    expect(formatSetupCode('7KQMX3RT9VHC')).toBe('7KQM-X3RT-9VHC');
  });

  it('normalizes what a person types: upper-case, no dashes, no whitespace', () => {
    expect(normalizeSetupCode(' 7kqm-x3rt 9vhc\t')).toBe('7KQMX3RT9VHC');
  });

  it('still matches a minted code (sha256 path), however it is typed', async () => {
    for (const typed of [
      '7KQM-X3RT-9VHC',
      '7kqm-x3rt-9vhc',
      ' 7KQM X3RT 9VHC ',
      '7KQMX3RT9VHC',
    ]) {
      expect(await setupCodeMatches(typed, '7KQMX3RT9VHC')).toBe(true);
    }
  });

  it('rejects a wrong, partial, longer, empty or non-text code', async () => {
    for (const typed of [
      '7KQM-X3RT-9VHD',
      '7KQM-X3RT',
      '7KQM-X3RT-9VHC-2222',
      '',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(await setupCodeMatches(typed, '7KQMX3RT9VHC')).toBe(false);
    }
  });

  describe('against a bcrypt hash (the sticker code, from the Device)', () => {
    const hash = bcrypt.hashSync('7KQMX3RT9VHC', 4);

    it('matches a typed code, normalized', async () => {
      expect(await setupCodeMatches('7kqm-x3rt-9vhc', hash)).toBe(true);
      expect(await setupCodeMatches(' 7KQM X3RT 9VHC ', hash)).toBe(true);
      expect(await setupCodeMatches('7KQMX3RT9VHD', hash)).toBe(false);
      expect(await setupCodeMatches(42, hash)).toBe(false);
    });

    it('isBcryptHash accepts the fixture only', () => {
      expect(isBcryptHash(hash)).toBe(true);
      expect(isBcryptHash('7KQMX3RT9VHC')).toBe(false);
      expect(isBcryptHash('$2b$04$short')).toBe(false);
    });

    it('compares one at a time', async () => {
      let active = 0;
      let peak = 0;
      const real = bcrypt.compare.bind(bcrypt);
      vi.spyOn(bcrypt, 'compare').mockImplementation((async (
        a: string,
        b: string,
      ) => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return real(a, b);
      }) as typeof bcrypt.compare);
      await Promise.all([
        setupCodeMatches('7KQMX3RT9VHC', hash),
        setupCodeMatches('7KQMX3RT9VHC', hash),
      ]);
      expect(peak).toBe(1);
      vi.restoreAllMocks();
    });
  });
});
