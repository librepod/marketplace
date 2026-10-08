import * as crypto from 'node:crypto';
import type { AppSettingItem, AppSettings, FieldError } from '@librepod/shared';

/** Validation limits (spec §5.3). */
export const SETTINGS_LIMITS = {
  nameMaxLength: 128,
  valueMaxBytes: 16 * 1024,
  totalMaxBytes: 64 * 1024,
  customMaxCount: 50,
} as const;

/**
 * The API's JSON body limit (main.ts). Any request whose settings fit the limits above
 * must reach resolveSettings, or the user gets a bare 413 instead of the field-level
 * "too large" message. JSON can spend six bytes on one byte of a value (a control
 * character becomes \u0001), so allow six times the total plus room for names and syntax.
 */
export const JSON_BODY_LIMIT_BYTES = 6 * SETTINGS_LIMITS.totalMaxBytes + 64 * 1024;

/** Platform-provided values: never an install question or a custom variable. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['BASE_DOMAIN']);

const CUSTOM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A plain decimal, as apps parse it (strconv, int(), parseInt): no spaces, hex, exponent or "+". */
const DECIMAL_NUMBER = /^-?\d+(\.\d+)?$/;

/** A fresh machine secret: `length` hex characters, the same shape the legacy generator made. */
const defaultRng = (length: number): string => crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);

export type ResolveResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: FieldError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The problem with one (non-empty) answer, or undefined when it is fine. */
function checkAnswer(item: AppSettingItem, value: string): string | undefined {
  const type = item.type ?? 'string';
  if (type === 'boolean' && value !== 'true' && value !== 'false') return 'Must be true or false';
  if (type === 'number' && !DECIMAL_NUMBER.test(value)) return 'Must be a number';
  if (item.options) {
    const choices = item.options.map(String);
    if (!choices.includes(value)) return `Must be one of: ${choices.join(', ')}`;
  }
  if (byteLength(value) > SETTINGS_LIMITS.valueMaxBytes) return 'Too long (max 16 KiB)';
  return undefined;
}

/**
 * Turns an install request body into the exact key/value map written to OpenBao.
 * Per question: the user's answer → the question's `default` → omitted. A question left out
 * of the request gets its default; an empty answer means "leave it unset" (so a user can clear
 * a pre-filled optional question). A generated item is never asked: with no answer it reuses
 * the value already in the OpenBao entry (`stored` — a reinstall keeps the running secret),
 * then the default, then a fresh random value (`rng`). Custom variables are added as given.
 * The returned map replaces the stored entry whole, so stored keys claimed by no item are
 * dropped. Values are never transformed: they are stored verbatim and never pass through
 * `${VAR}` substitution.
 */
export function resolveSettings(
  settings: AppSettings,
  body: unknown,
  stored?: Record<string, string> | null,
  rng: (length: number) => string = defaultRng,
): ResolveResult {
  const request = body ?? {};
  if (!isPlainObject(request)) {
    return { ok: false, errors: [{ name: 'settings', message: 'The request must be a JSON object' }] };
  }
  const answers = request.settings ?? {};
  if (!isPlainObject(answers)) {
    return { ok: false, errors: [{ name: 'settings', message: 'Must be an object of text values' }] };
  }

  const errors: FieldError[] = [];
  // No prototype: a custom variable named "__proto__" must land in the map like any other.
  const values: Record<string, string> = Object.create(null);
  const items = settings.items ?? [];
  const questionNames = new Set(items.map((item) => item.name));

  // --- install questions
  for (const key of Object.keys(answers)) {
    if (!questionNames.has(key)) errors.push({ name: key, message: 'Not a setting of this app' });
  }
  for (const item of items) {
    const raw = answers[item.name];
    if (raw !== undefined && typeof raw !== 'string') {
      errors.push({ name: item.name, message: 'Must be text' });
      continue;
    }
    // `default:` with no value parses as null in YAML: treat it as no default, not "null".
    const defaultValue = item.default === undefined || item.default === null ? undefined : String(item.default);
    // A generated item is never asked (the dialog hides it): with no answer it reuses the
    // value already stored in the OpenBao entry — a reinstall keeps the running secret —
    // then the default, then a fresh random value. An empty answer generates too: "clearing"
    // a machine secret means making a new one. `gen` is a local so the `!== undefined` check
    // keeps narrowing it down to the `rng` call.
    const gen = item.generate;
    const generated = (raw === undefined || raw === '') && gen !== undefined;
    const value = generated
      ? (stored?.[item.name] ?? defaultValue ?? rng(gen.length))
      : (raw ?? defaultValue ?? '');
    if (value === '') {
      if (item.required) errors.push({ name: item.name, message: 'Required' });
      continue;
    }
    // A generated value is machine-made, not a human answer: it is only checked when the item
    // also declares type/options constraints, which random text cannot satisfy.
    if (generated && !item.type && !item.options) {
      values[item.name] = value;
      continue;
    }
    const problem = checkAnswer(item, value);
    if (problem) errors.push({ name: item.name, message: problem });
    else values[item.name] = value;
  }

  // --- custom variables
  const custom = request.custom ?? [];
  if (!Array.isArray(custom)) {
    errors.push({ name: 'custom', message: 'Must be a list' });
  } else if (custom.length > 0 && !settings.allowCustom) {
    errors.push({ name: 'custom', message: 'This app does not accept custom variables' });
  } else if (custom.length > SETTINGS_LIMITS.customMaxCount) {
    errors.push({ name: 'custom', message: `At most ${SETTINGS_LIMITS.customMaxCount} custom variables` });
  } else {
    const seen = new Set<string>();
    custom.forEach((entry: unknown, index) => {
      const field = `custom.${index}`;
      if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
        errors.push({ name: field, message: 'Each variable needs a text name and value' });
        return;
      }
      const { name, value } = entry;
      if (!CUSTOM_NAME.test(name) || name.length > SETTINGS_LIMITS.nameMaxLength) {
        errors.push({ name: field, message: 'Use letters, digits and _ only, not starting with a digit' });
      } else if (RESERVED_NAMES.has(name)) {
        errors.push({ name: field, message: 'This name is reserved by LibrePod' });
      } else if (questionNames.has(name)) {
        errors.push({ name: field, message: 'Already set by a question above' });
      } else if (seen.has(name)) {
        errors.push({ name: field, message: 'Duplicate name' });
      } else {
        // Claimed even if the value turns out invalid, so a later copy is still a duplicate.
        seen.add(name);
        if (byteLength(value) > SETTINGS_LIMITS.valueMaxBytes) {
          errors.push({ name: field, message: 'Too long (max 16 KiB)' });
        } else {
          values[name] = value;
        }
      }
    });
  }

  const total = Object.entries(values).reduce((sum, [k, v]) => sum + byteLength(k) + byteLength(v), 0);
  if (total > SETTINGS_LIMITS.totalMaxBytes) {
    errors.push({ name: 'settings', message: 'All settings together are too large (max 64 KiB)' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
