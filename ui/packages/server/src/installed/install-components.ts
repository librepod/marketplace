import type { AppComponent, ComponentRequest, FieldError } from '@librepod/shared';
import type { CatalogApp } from '../catalog/catalog.types';
import { isPlainObject, resolveSettings } from './install-settings';

/**
 * Install values become bare YAML scalars under two levels of Flux substitution, so
 * whatever a component's own pattern allows, free text must never reach them.
 */
export const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export interface ResolvedComponent {
  name: string;
  version: string;
  /** The definition declares settings: its OpenBao entry and ExternalSecret exist. */
  hasSettings: boolean;
  /** Written to OpenBao apps/<app>/<name>. */
  settings: Record<string, string>;
  /** Install and app values, merged into the release's postBuild.substitute. */
  values: Record<string, string>;
}

type ResolveComponentsResult =
  | { ok: true; components: ResolvedComponent[] }
  | { ok: false; errors: FieldError[] };

function resolveOne(def: AppComponent, entry: ComponentRequest, errors: FieldError[]): ResolvedComponent {
  const scope = `components.${def.name}`;
  const settingsResult = resolveSettings({ items: def.settings ?? [] }, { settings: entry.settings ?? {} }, null);
  let settings: Record<string, string> = {};
  if (settingsResult.ok) {
    settings = { ...settingsResult.values };
  } else {
    for (const e of settingsResult.errors) {
      errors.push({ name: e.name === 'settings' ? scope : `${scope}.${e.name}`, message: e.message });
    }
  }

  const given = entry.values ?? {};
  const values: Record<string, string> = {};
  if (!isPlainObject(given)) {
    errors.push({ name: scope, message: 'values must be an object of text values' });
    return { name: def.name, version: def.version, hasSettings: !!def.settings?.length, settings, values };
  }
  const declared = new Set(def.values.map((v) => v.name));
  for (const key of Object.keys(given)) {
    if (!declared.has(key)) errors.push({ name: `${scope}.${key}`, message: 'Not a value of this component' });
  }
  for (const v of def.values) {
    const field = `${scope}.${v.name}`;
    if (v.from === 'app') {
      if (given[v.name] !== undefined) errors.push({ name: field, message: 'Set by the app' });
      else values[v.name] = v.default ?? '';
      continue;
    }
    const value = given[v.name] ?? v.default;
    if (typeof value !== 'string' || value === '') {
      errors.push({ name: field, message: 'Required' });
      continue;
    }
    let matches = true;
    try {
      matches = !v.pattern || new RegExp(v.pattern).test(value);
    } catch {
      matches = false;
    }
    if (!matches || !SAFE_VALUE.test(value)) errors.push({ name: field, message: 'Invalid value' });
    else values[v.name] = value;
  }
  return { name: def.name, version: def.version, hasSettings: !!def.settings?.length, settings, values };
}

/** Validates the install request's `components` against the app's catalog component list. */
export function resolveComponents(app: CatalogApp, body: unknown): ResolveComponentsResult {
  const request = isPlainObject(body) ? body : {};
  const asked = request.components ?? [];
  if (!Array.isArray(asked)) {
    return { ok: false, errors: [{ name: 'components', message: 'Must be a list' }] };
  }

  const errors: FieldError[] = [];
  const offered = new Map((app.components ?? []).map((c) => [c.name, c]));
  const seen = new Set<string>();
  const chosen: Array<{ def: AppComponent; entry: ComponentRequest }> = [];
  for (const entry of asked as unknown[]) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string') {
      errors.push({ name: 'components', message: 'Each component needs a name' });
      continue;
    }
    const def = offered.get(entry.name);
    if (!def) errors.push({ name: `components.${entry.name}`, message: 'Not a component of this app' });
    else if (seen.has(entry.name)) errors.push({ name: `components.${entry.name}`, message: 'Selected twice' });
    else chosen.push({ def, entry: entry as unknown as ComponentRequest });
    seen.add(entry.name);
  }

  const groups = new Map<string, number>();
  for (const { def } of chosen) if (def.group) groups.set(def.group, (groups.get(def.group) ?? 0) + 1);
  for (const [group, count] of groups) {
    if (count > 1) errors.push({ name: 'components', message: `Pick at most one ${group} component` });
  }

  const components = chosen
    .map(({ def, entry }) => resolveOne(def, entry, errors))
    .sort((a, b) => a.name.localeCompare(b.name));
  return errors.length > 0 ? { ok: false, errors } : { ok: true, components };
}
