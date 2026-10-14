import { describe, it, expect } from 'vitest';
import {
  SETUP_CODE_ALPHABET,
  formatSetupCode,
  generateSetupCode,
  normalizeSetupCode,
  setupCodeMatches,
} from './setup-code';

describe('setup code', () => {
  it('is 12 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSetupCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
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

  it('matches the code however it is typed', () => {
    for (const typed of ['7KQM-X3RT-9VHC', '7kqm-x3rt-9vhc', ' 7KQM X3RT 9VHC ', '7KQMX3RT9VHC']) {
      expect(setupCodeMatches(typed, '7KQMX3RT9VHC')).toBe(true);
    }
  });

  it('rejects a wrong, partial, longer, empty or non-text code', () => {
    for (const typed of ['7KQM-X3RT-9VHD', '7KQM-X3RT', '7KQM-X3RT-9VHC-2222', '', 42, null, undefined, {}]) {
      expect(setupCodeMatches(typed, '7KQMX3RT9VHC')).toBe(false);
    }
  });
});
