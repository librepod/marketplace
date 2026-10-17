import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OnboardingStore reads and writes system/marketplace-ui/onboarding and
 * system/admin. Without these grants every read is a 403 and the device sits on
 * "waking up" forever, so the policy is pinned to the store's paths here. The
 * openbao app lives five levels up from packages/server/src/onboarding.
 */
const OPENBAO = join(__dirname, '../../../../../apps/openbao');
const read = (path: string) => readFileSync(join(OPENBAO, path), 'utf8');

function capabilities(policy: string, path: string): string[] {
  const block = policy.match(new RegExp(`path "${path.replace(/\*/g, '\\*')}"\\s*\\{([^}]*)\\}`));
  return block ? [...block[1].matchAll(/"(\w+)"/g)].map((m) => m[1]) : [];
}

describe('marketplace-ui access to OpenBao system/', () => {
  const policy = read('overlays/librepod/policies/marketplace-ui-system.hcl');

  it.each(['system/data/marketplace-ui/*', 'system/data/admin'])('%s: create, update and read', (path) => {
    expect(capabilities(policy, path)).toEqual(expect.arrayContaining(['create', 'update', 'read']));
  });

  it('the policy file is mounted into the bootstrap Job', () => {
    expect(read('overlays/librepod/kustomization.yaml')).toContain(
      'marketplace-ui-system.hcl=policies/marketplace-ui-system.hcl',
    );
  });

  it('the marketplace-ui role carries it', () => {
    expect(read('components/bootstrap/bootstrap.sh')).toMatch(
      /role\/marketplace-ui \\[\s\S]*?policies=marketplace-ui-write-apps,marketplace-ui-system /,
    );
  });

  it('the bootstrap Job re-runs to apply it', () => {
    expect(read('components/bootstrap/job.yaml')).toContain('openbao.librepod/policies-version: "6"');
  });
});
