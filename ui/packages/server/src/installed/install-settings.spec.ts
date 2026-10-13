import { describe, it, expect } from 'vitest';
import type { AppSettings } from '@librepod/shared';
import { JSON_BODY_LIMIT_BYTES, resolveSettings, SETTINGS_LIMITS } from './install-settings';

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

    it('lets an empty answer clear an optional question that has a default', () => {
      const settings: AppSettings = { items: [{ name: 'HTTP_PROXY', default: 'http://proxy:3128' }] };
      expect(ok(settings, { settings: { HTTP_PROXY: '' } })).toEqual({});
      expect(ok(settings, {})).toEqual({ HTTP_PROXY: 'http://proxy:3128' });
    });

    it('still requires a required question answered with an empty string, even with a default', () => {
      const settings: AppSettings = { items: [{ name: 'TOKEN', required: true, default: 'x' }] };
      expect(errorsOf(settings, { settings: { TOKEN: '' } })).toEqual([{ name: 'TOKEN', message: 'Required' }]);
    });

    it('treats a YAML null default as no default, never the text "null"', () => {
      const settings: AppSettings = {
        items: [
          { name: 'OPTIONAL', default: null },
          { name: 'NEEDED', required: true, default: null },
        ],
      };
      expect(errorsOf(settings, {})).toEqual([{ name: 'NEEDED', message: 'Required' }]);
      expect(ok(settings, { settings: { NEEDED: 'v' } })).toEqual({ NEEDED: 'v' });
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

    it.each([' 8080 ', '0x1F', '0b11', '1e3', '+5', '.5', '5.', 'Infinity', '1_000'])(
      'rejects %j, which apps would not parse as a decimal number',
      (value) => {
        expect(errorsOf(renovate, { settings: { RENOVATE_TOKEN: 't', WORKERS: value } })).toEqual([
          { name: 'WORKERS', message: 'Must be a number' },
        ]);
      },
    );

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

    it('flags a repeated name even when its first use was rejected', () => {
      const big = 'x'.repeat(SETTINGS_LIMITS.valueMaxBytes + 1);
      expect(
        errorsOf(renovate, {
          ...answered,
          custom: [
            { name: 'A', value: big },
            { name: 'A', value: 'x' },
          ],
        }),
      ).toEqual([
        { name: 'custom.0', message: 'Too long (max 16 KiB)' },
        { name: 'custom.1', message: 'Duplicate name' },
      ]);
    });

    it('keeps a variable named __proto__ like any other', () => {
      const values = ok(renovate, { ...answered, custom: [{ name: '__proto__', value: 'x' }] });
      expect(Object.keys(values)).toContain('__proto__');
      expect(values['__proto__']).toBe('x');
      expect(JSON.parse(JSON.stringify(values)).__proto__).toBe('x');
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

    it('fits the JSON body limit even when every byte of the largest valid request is escaped', () => {
      // \u0001 is the worst case: one byte of value, six bytes of JSON.
      const perValue = Math.floor(SETTINGS_LIMITS.totalMaxBytes / SETTINGS_LIMITS.customMaxCount) - 4;
      const custom = Array.from({ length: SETTINGS_LIMITS.customMaxCount }, (_, i) => ({
        name: `V${String(i).padStart(2, '0')}`,
        value: '\u0001'.repeat(perValue),
      }));
      const body = { ...answered, custom };
      expect(ok(renovate, body)).toBeTruthy();
      expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(JSON_BODY_LIMIT_BYTES);
    });

    it('limits all settings together to 64 KiB', () => {
      const chunk = 'x'.repeat(15 * 1024);
      const custom = Array.from({ length: 5 }, (_, i) => ({ name: `V${i}`, value: chunk }));
      expect(errorsOf(renovate, { ...answered, custom })).toEqual([
        { name: 'settings', message: 'All settings together are too large (max 64 KiB)' },
      ]);
    });
  });

  describe('generated items', () => {
    const gen = (length: number) => `x`.repeat(length);
    const settings: AppSettings = {
      items: [
        { name: 'DB_PASSWORD', generate: { length: 40 } },
        { name: 'TOKEN', required: true, sensitive: true },
      ],
    };

    it('generates when no answer, no default, no stored value', () => {
      const r = resolveSettings(settings, { settings: { TOKEN: 't' } }, null, gen);
      expect(r.ok && r.values.DB_PASSWORD).toBe('x'.repeat(40));
    });

    it('reuses the stored value for a generated item', () => {
      const r = resolveSettings(settings, { settings: { TOKEN: 't' } }, { DB_PASSWORD: 'old' }, gen);
      expect(r.ok && r.values.DB_PASSWORD).toBe('old');
    });

    it('an explicit answer wins over the stored value', () => {
      const r = resolveSettings(settings, { settings: { TOKEN: 't', DB_PASSWORD: 'chosen' } }, { DB_PASSWORD: 'old' }, gen);
      expect(r.ok && r.values.DB_PASSWORD).toBe('chosen');
    });

    it('the stored value wins over a default; the default wins when nothing is stored', () => {
      const s: AppSettings = { items: [{ name: 'A', default: 'def', generate: { length: 8 } }] };
      expect(resolveSettings(s, {}, { A: 'old' }, gen)).toMatchObject({ ok: true, values: { A: 'old' } });
      expect(resolveSettings(s, {}, null, gen)).toMatchObject({ ok: true, values: { A: 'def' } });
    });

    it('does NOT resurrect stored values for question items', () => {
      const r = resolveSettings(settings, { settings: { TOKEN: '' } }, { TOKEN: 'old-token', DB_PASSWORD: 'old' }, gen);
      // TOKEN answered empty → omitted (required error); stored TOKEN is ignored
      expect(r.ok).toBe(false);
    });

    it('drops stored keys claimed by no item (replace semantics)', () => {
      const r = resolveSettings(settings, { settings: { TOKEN: 't' } }, { STALE: 'z', DB_PASSWORD: 'old' }, gen);
      expect(r.ok && r.values.STALE).toBeUndefined();
    });
  });
});
