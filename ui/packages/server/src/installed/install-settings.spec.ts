import { describe, it, expect } from 'vitest';
import type { AppSettings } from '@librepod/shared';
import { resolveSettings, SETTINGS_LIMITS } from './install-settings';

const renovate: AppSettings = {
  allowCustom: true,
  items: [
    { name: 'RENOVATE_TOKEN', sensitive: true, required: true },
    { name: 'LOG_FORMAT', options: ['json', 'pretty'], default: 'json' },
    { name: 'DRY_RUN', type: 'boolean', default: false },
    { name: 'WORKERS', type: 'number' },
  ],
};

function ok(settings: AppSettings, body: unknown): Record<string, string> {
  const result = resolveSettings(settings, body);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result.values;
}

function errorsOf(settings: AppSettings, body: unknown) {
  const result = resolveSettings(settings, body);
  if (result.ok) throw new Error(`expected errors, got ${JSON.stringify(result.values)}`);
  return result.errors;
}

describe('resolveSettings', () => {
  describe('install questions', () => {
    it('uses the answer, then the default, and omits unanswered optional questions', () => {
      expect(ok(renovate, { settings: { RENOVATE_TOKEN: 't', LOG_FORMAT: 'pretty' } })).toEqual({
        RENOVATE_TOKEN: 't',
        LOG_FORMAT: 'pretty',
        DRY_RUN: 'false',
      });
    });

    it('treats an empty answer as no answer', () => {
      expect(ok(renovate, { settings: { RENOVATE_TOKEN: 't', LOG_FORMAT: '' } }).LOG_FORMAT).toBe('json');
    });

    it.each([undefined, null, {}])('treats a missing body (%s) as all defaults', (body) => {
      expect(ok({ items: [{ name: 'LOG_FORMAT', default: 'json' }] }, body)).toEqual({ LOG_FORMAT: 'json' });
    });

    it('normalises YAML scalars in default and options to text', () => {
      const settings: AppSettings = {
        items: [
          { name: 'ENABLED', type: 'boolean', default: false },
          { name: 'PORT', type: 'number', default: 8080 },
          { name: 'LEVEL', options: [1, 2, 3], default: 2 },
        ],
      };
      expect(ok(settings, {})).toEqual({ ENABLED: 'false', PORT: '8080', LEVEL: '2' });
      expect(ok(settings, { settings: { LEVEL: '3' } }).LEVEL).toBe('3');
    });

    it('requires required questions', () => {
      expect(errorsOf(renovate, {})).toEqual([{ name: 'RENOVATE_TOKEN', message: 'Required' }]);
    });

    it('checks options, booleans and numbers', () => {
      expect(
        errorsOf(renovate, {
          settings: { RENOVATE_TOKEN: 't', LOG_FORMAT: 'xml', DRY_RUN: 'yes', WORKERS: 'many' },
        }),
      ).toEqual([
        { name: 'LOG_FORMAT', message: 'Must be one of: json, pretty' },
        { name: 'DRY_RUN', message: 'Must be true or false' },
        { name: 'WORKERS', message: 'Must be a number' },
      ]);
    });

    it('accepts decimal and negative numbers', () => {
      expect(ok(renovate, { settings: { RENOVATE_TOKEN: 't', WORKERS: '-1.5' } }).WORKERS).toBe('-1.5');
    });

    it('rejects answers to questions the app does not ask', () => {
      expect(errorsOf(renovate, { settings: { RENOVATE_TOKEN: 't', NOPE: 'x' } })).toEqual([
        { name: 'NOPE', message: 'Not a setting of this app' },
      ]);
    });

    it('rejects non-text answers', () => {
      expect(errorsOf(renovate, { settings: { RENOVATE_TOKEN: 42 } })).toEqual([
        { name: 'RENOVATE_TOKEN', message: 'Must be text' },
      ]);
    });

    it.each([[[]], ['text'], [7]])('rejects a body that is not an object: %j', (body) => {
      expect(errorsOf(renovate, body)).toEqual([
        { name: 'settings', message: 'The request must be a JSON object' },
      ]);
    });

    it('rejects settings that are not an object', () => {
      expect(errorsOf(renovate, { settings: ['x'] })).toEqual([
        { name: 'settings', message: 'Must be an object of text values' },
      ]);
    });

    it('stores tricky text exactly as typed', () => {
      const tricky = ['on', 'no', 'a: b #c', '${BASE_DOMAIN}', 'line1\nline2', '"double" \'single\'', '  padded  ', 'ключ ✓'];
      for (const value of tricky) {
        expect(ok(renovate, { settings: { RENOVATE_TOKEN: value } }).RENOVATE_TOKEN).toBe(value);
      }
    });

    it('rejects an answer over 16 KiB', () => {
      const big = 'x'.repeat(SETTINGS_LIMITS.valueMaxBytes + 1);
      expect(errorsOf(renovate, { settings: { RENOVATE_TOKEN: big } })).toEqual([
        { name: 'RENOVATE_TOKEN', message: 'Too long (max 16 KiB)' },
      ]);
    });
  });

  describe('custom variables', () => {
    const answered = { settings: { RENOVATE_TOKEN: 't' } };

    it('adds them next to the answers', () => {
      expect(
        ok(renovate, {
          ...answered,
          custom: [
            { name: 'http_proxy', value: 'http://p:3128' },
            { name: 'EMPTY', value: '' },
          ],
        }),
      ).toEqual({ RENOVATE_TOKEN: 't', LOG_FORMAT: 'json', DRY_RUN: 'false', http_proxy: 'http://p:3128', EMPTY: '' });
    });

    it('rejects them when the app does not allow custom variables', () => {
      expect(errorsOf({ items: [] }, { custom: [{ name: 'A', value: '1' }] })).toEqual([
        { name: 'custom', message: 'This app does not accept custom variables' },
      ]);
    });

    it('accepts an empty list even when not allowed', () => {
      expect(ok({ items: [] }, { custom: [] })).toEqual({});
    });

    it('rejects a custom value that is not a list', () => {
      expect(errorsOf(renovate, { ...answered, custom: {} })).toEqual([
        { name: 'custom', message: 'Must be a list' },
      ]);
    });

    it('validates each variable and points at its position', () => {
      expect(
        errorsOf(renovate, {
          ...answered,
          custom: [
            { name: '1BAD', value: 'x' },
            { name: 'BASE_DOMAIN', value: 'x' },
            { name: 'RENOVATE_TOKEN', value: 'x' },
            { name: 'OK', value: 'x' },
            { name: 'OK', value: 'y' },
            { name: 'N', value: 5 },
            'junk',
          ],
        }),
      ).toEqual([
        { name: 'custom.0', message: 'Use letters, digits and _ only, not starting with a digit' },
        { name: 'custom.1', message: 'This name is reserved by LibrePod' },
        { name: 'custom.2', message: 'Already set by a question above' },
        { name: 'custom.4', message: 'Duplicate name' },
        { name: 'custom.5', message: 'Each variable needs a text name and value' },
        { name: 'custom.6', message: 'Each variable needs a text name and value' },
      ]);
    });

    it('rejects names over 128 characters', () => {
      expect(errorsOf(renovate, { ...answered, custom: [{ name: 'A'.repeat(129), value: 'x' }] })).toEqual([
        { name: 'custom.0', message: 'Use letters, digits and _ only, not starting with a digit' },
      ]);
    });

    it('allows at most 50 custom variables', () => {
      const custom = Array.from({ length: SETTINGS_LIMITS.customMaxCount + 1 }, (_, i) => ({ name: `V${i}`, value: 'x' }));
      expect(errorsOf(renovate, { ...answered, custom })).toEqual([
        { name: 'custom', message: 'At most 50 custom variables' },
      ]);
    });

    it('rejects a custom value over 16 KiB', () => {
      const big = 'x'.repeat(SETTINGS_LIMITS.valueMaxBytes + 1);
      expect(errorsOf(renovate, { ...answered, custom: [{ name: 'BIG', value: big }] })).toEqual([
        { name: 'custom.0', message: 'Too long (max 16 KiB)' },
      ]);
    });

    it('limits all settings together to 64 KiB', () => {
      const chunk = 'x'.repeat(15 * 1024);
      const custom = Array.from({ length: 5 }, (_, i) => ({ name: `V${i}`, value: chunk }));
      expect(errorsOf(renovate, { ...answered, custom })).toEqual([
        { name: 'settings', message: 'All settings together are too large (max 64 KiB)' },
      ]);
    });
  });
});
