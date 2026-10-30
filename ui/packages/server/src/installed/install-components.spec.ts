import { describe, it, expect } from 'vitest';
import type { AppComponent } from '@librepod/shared';
import type { CatalogApp } from '../catalog/catalog.types';
import { resolveComponents } from './install-components';

const DNS_LABEL = '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$';

const tailscale: AppComponent = {
  name: 'tailscale',
  displayName: 'Tailscale',
  description: 'd',
  version: 'v1.104.2',
  group: 'network',
  kind: 'patch',
  settings: [
    { name: 'TS_AUTHKEY', type: 'string', required: true, sensitive: true },
    { name: 'TS_EXTRA_ARGS', type: 'string' },
  ],
  values: [{ name: 'TS_HOSTNAME', from: 'install', default: 'immich', pattern: DNS_LABEL }],
};
const gluetun: AppComponent = {
  name: 'gluetun',
  displayName: 'gluetun',
  description: 'd',
  version: 'v3.41.3',
  group: 'network',
  kind: 'patch',
  settings: [{ name: 'WG_CONFIG', type: 'text', required: true, sensitive: true }],
  values: [],
};
const frp: AppComponent = {
  name: 'frp-expose',
  displayName: 'FRP',
  description: 'd',
  version: '1.0.0',
  kind: 'resource',
  values: [
    { name: 'FRP_EXPOSE_HOST', from: 'app', default: 'immich-server.immich.svc.cluster.local' },
    { name: 'FRP_EXPOSE_PORT', from: 'app', default: '2283' },
    { name: 'FRP_EXPOSE_SUBDOMAIN', from: 'install', default: 'immich', pattern: DNS_LABEL },
  ],
};
const app = { name: 'immich', components: [tailscale, gluetun, frp] } as unknown as CatalogApp;
const errorsOf = (body: unknown) => {
  const r = resolveComponents(app, body);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
};

describe('resolveComponents', () => {
  it('returns no components when the body has none', () => {
    for (const body of [{}, undefined, { components: [] }]) {
      expect(resolveComponents(app, body)).toEqual({ ok: true, components: [] });
    }
  });

  it('rejects a non-list', () => {
    expect(errorsOf({ components: 'x' }).map((e) => e.name)).toEqual(['components']);
  });

  it('rejects an unknown component', () => {
    expect(errorsOf({ components: [{ name: 'nope' }] }).map((e) => e.name)).toEqual(['components.nope']);
  });

  it('rejects a duplicate', () => {
    const errors = errorsOf({ components: [{ name: 'frp-expose' }, { name: 'frp-expose' }] });
    expect(errors.map((e) => e.name)).toEqual(['components.frp-expose']);
  });

  it('rejects two network components', () => {
    const errors = errorsOf({
      components: [
        { name: 'tailscale', settings: { TS_AUTHKEY: 'k' } },
        { name: 'gluetun', settings: { WG_CONFIG: 'c' } },
      ],
    });
    expect(errors).toEqual([{ name: 'components', message: expect.stringContaining('network') }]);
  });

  it('requires required settings', () => {
    const errors = errorsOf({ components: [{ name: 'tailscale' }] });
    expect(errors).toEqual([{ name: 'components.tailscale.TS_AUTHKEY', message: 'Required' }]);
  });

  it('uses the install default', () => {
    const r = resolveComponents(app, { components: [{ name: 'frp-expose' }] });
    expect(r).toEqual({
      ok: true,
      components: [
        {
          name: 'frp-expose',
          version: '1.0.0',
          hasSettings: false,
          settings: {},
          values: {
            FRP_EXPOSE_HOST: 'immich-server.immich.svc.cluster.local',
            FRP_EXPOSE_PORT: '2283',
            FRP_EXPOSE_SUBDOMAIN: 'immich',
          },
        },
      ],
    });
  });

  it('resolves component settings and values', () => {
    const r = resolveComponents(app, {
      components: [{ name: 'tailscale', settings: { TS_AUTHKEY: 'k' }, values: { TS_HOSTNAME: 'box' } }],
    });
    expect(r).toMatchObject({
      ok: true,
      components: [{ name: 'tailscale', hasSettings: true, settings: { TS_AUTHKEY: 'k' }, values: { TS_HOSTNAME: 'box' } }],
    });
  });

  it('rejects a value failing the pattern', () => {
    const errors = errorsOf({ components: [{ name: 'frp-expose', values: { FRP_EXPOSE_SUBDOMAIN: 'Bad_Name' } }] });
    expect(errors.map((e) => e.name)).toEqual(['components.frp-expose.FRP_EXPOSE_SUBDOMAIN']);
  });

  it('rejects install values outside SAFE_VALUE even when the pattern allows them', () => {
    const loose: AppComponent = { ...frp, values: frp.values.map((v) => (v.from === 'install' ? { ...v, pattern: '^.*$' } : v)) };
    const looseApp = { name: 'immich', components: [loose] } as unknown as CatalogApp;
    for (const bad of ['a b', '${X}', 'a:b', 'a\nb']) {
      const r = resolveComponents(looseApp, { components: [{ name: 'frp-expose', values: { FRP_EXPOSE_SUBDOMAIN: bad } }] });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejects install values YAML would read as a number, boolean or null', () => {
    for (const bad of ['1234', '1e5', 'on', 'Yes', 'true', 'null', '0x1f']) {
      const r = resolveComponents(app, { components: [{ name: 'frp-expose', values: { FRP_EXPOSE_SUBDOMAIN: bad } }] })
      expect(r.ok, bad).toBe(false)
    }
    const ok = resolveComponents(app, { components: [{ name: 'frp-expose', values: { FRP_EXPOSE_SUBDOMAIN: 'photos2' } }] })
    expect(ok.ok).toBe(true)
  })

  it('rejects overriding a from:app value', () => {
    const errors = errorsOf({ components: [{ name: 'frp-expose', values: { FRP_EXPOSE_PORT: '1' } }] });
    expect(errors).toEqual([{ name: 'components.frp-expose.FRP_EXPOSE_PORT', message: 'Set by the app' }]);
  });

  it('rejects an unknown value key', () => {
    const errors = errorsOf({ components: [{ name: 'frp-expose', values: { NOPE: 'x' } }] });
    expect(errors.map((e) => e.name)).toEqual(['components.frp-expose.NOPE']);
  });
});
