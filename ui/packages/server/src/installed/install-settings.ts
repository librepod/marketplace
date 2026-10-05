import type { AppSettingItem, AppSettings, FieldError } from '@librepod/shared';

/** Validation limits (spec §5.3) — keep a request under Nest's 100 KB JSON body limit. */
export const SETTINGS_LIMITS = {
  nameMaxLength: 128,
  valueMaxBytes: 16 * 1024,
  totalMaxBytes: 64 * 1024,
  customMaxCount: 50,
} as const;

/** Platform-provided values: never an install question or a custom variable. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['BASE_DOMAIN']);

const CUSTOM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  if (type === 'number' && (value.trim() === '' || !Number.isFinite(Number(value)))) return 'Must be a number';
  if (item.options) {
    const choices = item.options.map(String);
    if (!choices.includes(value)) return `Must be one of: ${choices.join(', ')}`;
  }
  if (byteLength(value) > SETTINGS_LIMITS.valueMaxBytes) return 'Too long (max 16 KiB)';
  return undefined;
}

/**
 * Turns an install request body into the exact key/value map written to OpenBao.
 * Per question: the user's answer → the question's `default` → omitted (optional and
 * unanswered). Custom variables are added as given. Values are never transformed: they are
 * stored verbatim and never pass through `${VAR}` substitution.
 */
export function resolveSettings(settings: AppSettings, body: unknown): ResolveResult {
  const request = body ?? {};
  if (!isPlainObject(request)) {
    return { ok: false, errors: [{ name: 'settings', message: 'The request must be a JSON object' }] };
  }
  const answers = request.settings ?? {};
  if (!isPlainObject(answers)) {
    return { ok: false, errors: [{ name: 'settings', message: 'Must be an object of text values' }] };
  }

  const errors: FieldError[] = [];
  const values: Record<string, string> = {};
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
    const value = raw ? raw : item.default !== undefined ? String(item.default) : '';
    if (value === '') {
      if (item.required) errors.push({ name: item.name, message: 'Required' });
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
      } else if (byteLength(value) > SETTINGS_LIMITS.valueMaxBytes) {
        errors.push({ name: field, message: 'Too long (max 16 KiB)' });
      } else {
        seen.add(name);
        values[name] = value;
      }
    });
  }

  const total = Object.entries(values).reduce((sum, [k, v]) => sum + byteLength(k) + byteLength(v), 0);
  if (total > SETTINGS_LIMITS.totalMaxBytes) {
    errors.push({ name: 'settings', message: 'All settings together are too large (max 64 KiB)' });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
