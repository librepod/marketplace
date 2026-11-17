import { BadRequestException } from '@nestjs/common';
import type {
  DeviceInstallRequest,
  DevicePowerRequest,
  DeviceSshKeysRequest,
  DeviceUpdateSettingsRequest,
} from '@librepod/shared';

const TZ_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const KEY_PATTERN = /^[a-z0-9@.-]+ AAAA[A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;
const MAX_KEYS = 32;
const MAX_KEY_LEN = 8192;

const bad = (message: string): never => {
  throw new BadRequestException({ message });
};
const obj = (b: unknown): Record<string, unknown> =>
  typeof b === 'object' && b !== null
    ? (b as Record<string, unknown>)
    : bad('Expected a JSON object');

// Intl.supportedValuesOf('timeZone') lists only old CLDR names (no Asia/Kolkata, Europe/Kyiv),
// so ask Intl itself; the device's tzdata stays the authority (rejected.updates).
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length > 64 || !TZ_PATTERN.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseUpdateSettings(
  body: unknown,
): DeviceUpdateSettingsRequest {
  const { channel, auto, timezone } = obj(body);
  if (channel !== 'stable' && channel !== 'beta')
    bad('channel must be stable or beta');
  if (typeof auto !== 'boolean') bad('auto must be true or false');
  if (!isTimeZone(timezone)) bad('timezone is not a known time zone');
  return {
    channel: channel as 'stable' | 'beta',
    auto: auto as boolean,
    timezone: timezone as string,
  };
}

export function parseInstall(body: unknown): DeviceInstallRequest {
  const { when } = obj(body);
  if (when !== 'now' && when !== 'tonight') bad('when must be now or tonight');
  return { when: when as 'now' | 'tonight' };
}

export function parsePower(body: unknown): DevicePowerRequest {
  const { action } = obj(body);
  if (action !== 'reboot' && action !== 'poweroff')
    bad('action must be reboot or poweroff');
  return { action: action as 'reboot' | 'poweroff' };
}

export function parseSshKeys(body: unknown): DeviceSshKeysRequest {
  const { keys } = obj(body);
  if (!Array.isArray(keys)) return bad('keys must be a list');
  if (keys.length > MAX_KEYS) bad(`at most ${MAX_KEYS} keys`);
  keys.forEach((k, i) => {
    if (
      typeof k !== 'string' ||
      k.length > MAX_KEY_LEN ||
      !KEY_PATTERN.test(k)
    ) {
      bad(`key ${i + 1} is not a public key (key type first, no options)`);
    }
  });
  return { keys: keys as string[] };
}
