import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import type { AppSettings } from '@librepod/shared';
import { resolveSettings } from './install-settings';

/**
 * wg-easy's catalog entry is a contract with the first-run wizard: the wizard
 * answers INIT_PASSWORD (server-side, from OpenBao system/admin) and INIT_HOST
 * (the endpoint the owner confirmed), and the release must substitute only
 * the two platform variables the installer fills. The app lives in the
 * marketplace repo, five levels up from packages/server/src/installed.
 */
const APP = join(__dirname, '../../../../../apps/wg-easy');
const metadata = load(readFileSync(join(APP, 'metadata.yaml'), 'utf8')) as {
  spec: { settings: AppSettings; templates: { release: string } };
};
const settings = metadata.spec.settings;
const item = (name: string) => settings.items?.find((i) => i.name === name);

describe('wg-easy catalog entry', () => {
  it('asks for the admin password with no default — master\'s "change-me" was too short to ever log in', () => {
    expect(item('INIT_PASSWORD')).toMatchObject({ required: true, sensitive: true });
    expect(item('INIT_PASSWORD')?.default).toBeUndefined();
    expect(item('INIT_PASSWORD')?.description).toMatch(/12 characters/);
  });

  it('asks for an optional endpoint host with no default', () => {
    expect(item('INIT_HOST')).toMatchObject({ label: 'Endpoint host' });
    expect(item('INIT_HOST')?.required).toBeFalsy();
    expect(item('INIT_HOST')?.default).toBeUndefined();
  });

  it('an empty endpoint answer never becomes an empty key in the settings Secret', () => {
    const resolved = resolveSettings(settings, { settings: { INIT_PASSWORD: 'correct-horse-12', INIT_HOST: '' } });
    expect(resolved).toEqual({ ok: true, values: { INIT_PASSWORD: 'correct-horse-12' } });
  });

  it('a non-empty endpoint answer is stored, so it overrides the ConfigMap default', () => {
    const resolved = resolveSettings(settings, { settings: { INIT_PASSWORD: 'correct-horse-12', INIT_HOST: '203.0.113.7' } });
    expect(resolved).toEqual({ ok: true, values: { INIT_PASSWORD: 'correct-horse-12', INIT_HOST: '203.0.113.7' } });
  });

  it('no admin password is an error, not a fallback', () => {
    expect(resolveSettings(settings, { settings: {} })).toEqual({
      ok: false,
      errors: [{ name: 'INIT_PASSWORD', message: 'Required' }],
    });
  });

  it('the release substitutes exactly BASE_DOMAIN and DEVICE_IP', () => {
    const release = load(metadata.spec.templates.release) as { spec: { postBuild: { substitute: Record<string, string> } } };
    expect(Object.keys(release.spec.postBuild.substitute).sort()).toEqual(['BASE_DOMAIN', 'DEVICE_IP']);
  });

  it("the endpoint default is the device's IP, empty (never junk) when unsubstituted", () => {
    const env = readFileSync(join(APP, 'base/wg-easy.env'), 'utf8');
    expect(env).toMatch(/^INIT_HOST=\$\{DEVICE_IP:=\}$/m);
    expect(env).not.toContain('FRP_SERVER_ADDR');
  });
});
