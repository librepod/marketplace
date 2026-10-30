import type { AppComponent, ComponentDefinition } from '@librepod/shared';
import type { AppComponentRef } from './catalog.types';

/**
 * Joins an app's metadata opt-ins with the catalog's component definitions so the
 * client and the installer see one list with final defaults: `{app}` filled and the
 * app's own values applied. An entry that cannot be offered is dropped with a warning
 * (the catalog CI gate should have caught it) rather than failing the whole catalog.
 */
export function joinComponents(
  appName: string,
  refs: AppComponentRef[] | undefined,
  defs: Record<string, ComponentDefinition> | undefined,
  warn: (msg: string) => void,
): AppComponent[] {
  const out: AppComponent[] = [];
  for (const ref of refs ?? []) {
    const def = defs?.[ref.name];
    if (!def) {
      warn(`${appName}: unknown component "${ref.name}"`);
      continue;
    }
    const given = ref.values ?? {};
    const missing = (def.values ?? []).find((v) => v.from === 'app' && given[v.name] === undefined);
    if (missing) {
      warn(`${appName}: component "${ref.name}" lacks the from:app value ${missing.name}`);
      continue;
    }
    const values = (def.values ?? []).map((v) => ({
      ...v,
      default:
        v.from === 'app'
          ? String(given[v.name])
          : String(given[v.name] ?? v.default ?? '').replaceAll('{app}', appName),
    }));
    out.push({ ...def, name: ref.name, values });
  }
  return out;
}
