import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  parseUpdateSettings,
  parseInstall,
  parsePower,
  parseSshKeys,
} from './device-input';

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq me@laptop';
const msg = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).message;
  }
  throw new Error('did not throw');
};

describe('parseUpdateSettings', () => {
  it('accepts stable/beta, boolean auto, a known zone, and UTC', () => {
    expect(
      parseUpdateSettings({
        channel: 'beta',
        auto: false,
        timezone: 'Europe/Minsk',
      }),
    ).toEqual({ channel: 'beta', auto: false, timezone: 'Europe/Minsk' });
    expect(
      parseUpdateSettings({ channel: 'stable', auto: true, timezone: 'UTC' })
        .timezone,
    ).toBe('UTC');
  });
  it('accepts valid IANA zones that Intl.supportedValuesOf omits (Node lists only old CLDR names)', () => {
    for (const timezone of ['Asia/Kolkata', 'Europe/Kyiv', 'Etc/UTC']) {
      expect(parseUpdateSettings({ channel: 'stable', auto: true, timezone }).timezone).toBe(timezone);
    }
  });
  it.each([
    [{ channel: 'nightly', auto: true, timezone: 'UTC' }],
    [{ channel: 'stable', auto: 'yes', timezone: 'UTC' }],
    [{ channel: 'stable', auto: true, timezone: 'Mars/Base' }],
    [{ channel: 'stable', auto: true, timezone: '../etc' }],
    [{ channel: 'stable', auto: true, timezone: 'A'.repeat(65) }],
    [null],
  ])('rejects %j', (b) =>
    expect(() => parseUpdateSettings(b)).toThrow(BadRequestException),
  );
});

describe('parseInstall / parsePower', () => {
  it('install: now|tonight only', () => {
    expect(parseInstall({ when: 'now' })).toEqual({ when: 'now' });
    expect(parseInstall({ when: 'tonight' })).toEqual({ when: 'tonight' });
    expect(() => parseInstall({ when: 'later' })).toThrow(BadRequestException);
  });
  it('power: reboot|poweroff only', () => {
    expect(parsePower({ action: 'reboot' })).toEqual({ action: 'reboot' });
    expect(parsePower({ action: 'poweroff' })).toEqual({ action: 'poweroff' });
    expect(() => parsePower({ action: 'halt' })).toThrow(BadRequestException);
  });
});

describe('parseSshKeys', () => {
  it('up to 32 valid keys', () => {
    expect(parseSshKeys({ keys: Array(32).fill(KEY) }).keys).toHaveLength(32);
    expect(() => parseSshKeys({ keys: Array(33).fill(KEY) })).toThrow(
      BadRequestException,
    );
  });
  it('rejects options', () => {
    expect(msg(() => parseSshKeys({ keys: [`command="x" ${KEY}`] }))).toBe(
      'key 1 is not a public key (key type first, no options)',
    );
  });
  it('names the bad key counting from 1', () => {
    expect(msg(() => parseSshKeys({ keys: [KEY, 'nope'] }))).toContain(
      'key 2 ',
    );
  });
  it('rejects a key with a CR', () => {
    expect(() => parseSshKeys({ keys: [`${KEY}\r`] })).toThrow(
      BadRequestException,
    );
  });
  it('accepts an empty list', () => {
    expect(parseSshKeys({ keys: [] })).toEqual({ keys: [] });
  });
  it('rejects a non-string entry', () => {
    expect(() => parseSshKeys({ keys: [42] })).toThrow(BadRequestException);
  });
});
