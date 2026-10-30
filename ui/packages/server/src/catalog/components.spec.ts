import { describe, it, expect, vi } from 'vitest';
import type { ComponentDefinition } from '@librepod/shared';
import { joinComponents } from './components';

const DNS_LABEL = '^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$';

const defs: Record<string, ComponentDefinition> = {
  'frp-expose': {
    displayName: 'Public HTTPS exposure',
    description: 'd',
    version: '1.0.0',
    kind: 'resource',
    values: [
      { name: 'FRP_EXPOSE_HOST', from: 'app' },
      { name: 'FRP_EXPOSE_PORT', from: 'app' },
      { name: 'FRP_EXPOSE_SUBDOMAIN', from: 'install', default: '{app}', pattern: DNS_LABEL },
    ],
  },
  tailscale: {
    displayName: 'Tailscale',
    description: 'd',
    version: 'v1.104.2',
    group: 'network',
    kind: 'patch',
    values: [{ name: 'TS_HOSTNAME', from: 'install', default: '{app}', pattern: DNS_LABEL }],
  },
};

const frp = { FRP_EXPOSE_HOST: 'h.svc', FRP_EXPOSE_PORT: 2283 };

describe('joinComponents', () => {
  it('fills {app} into install defaults', () => {
    const [c] = joinComponents('immich', [{ name: 'frp-expose', values: frp }], defs, vi.fn());
    expect(c.values.find((v) => v.name === 'FRP_EXPOSE_SUBDOMAIN')?.default).toBe('immich');
    expect(c.name).toBe('frp-expose');
    expect(c.version).toBe('1.0.0');
  });

  it('lets the app override an install default', () => {
    const [c] = joinComponents('collie', [{ name: 'tailscale', values: { TS_HOSTNAME: 'collie-lead' } }], defs, vi.fn());
    expect(c.values[0].default).toBe('collie-lead');
  });

  it('fills from:app values', () => {
    const [c] = joinComponents('immich', [{ name: 'frp-expose', values: frp }], defs, vi.fn());
    expect(c.values.find((v) => v.name === 'FRP_EXPOSE_PORT')?.default).toBe('2283');
  });

  it('drops unknown components with a warning', () => {
    const warn = vi.fn();
    expect(joinComponents('x', [{ name: 'nope' }], defs, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });

  it('drops a component missing a from:app value with a warning', () => {
    const warn = vi.fn();
    expect(joinComponents('x', [{ name: 'frp-expose', values: { FRP_EXPOSE_HOST: 'h' } }], defs, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FRP_EXPOSE_PORT'));
  });
});
