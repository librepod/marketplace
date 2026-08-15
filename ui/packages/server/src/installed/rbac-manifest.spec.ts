import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAll } from 'js-yaml';

/**
 * Guards the marketplace-ui ServiceAccount RBAC against the Kubernetes custom
 * resources the server actually lists at runtime. The launch tile silently
 * mis-behaves (every app falls back to the computed https://<name>.<domain>,
 * ignoring both the librepod.org/launch override and the zero-IngressRoute
 * suppression) if the ClusterRole cannot read a resource the code queries,
 * because LaunchUrlService swallows the RBAC error and returns "no opinion".
 *
 * The manifest lives in the marketplace repo (this ui/ dir is a subdir of it),
 * five levels up from packages/server/src/installed.
 */
const MANIFEST = join(
  __dirname,
  '../../../../../apps/marketplace-ui/base/serviceaccount.yaml',
);

interface PolicyRule {
  apiGroups?: string[];
  resources?: string[];
  verbs?: string[];
}
interface ClusterRoleDoc {
  kind?: string;
  metadata?: { name?: string };
  rules?: PolicyRule[];
}

// (apiGroup, resource) pairs the server lists via CustomObjectsApi. Keep in
// lockstep with the group/plural pairs in *.service.ts (LaunchUrlService reads
// ingressroutes; FluxStatusService / SystemAppsService read the others).
const READS: Array<{ group: string; resource: string; readBy: string }> = [
  { group: 'traefik.io', resource: 'ingressroutes', readBy: 'LaunchUrlService' },
  {
    group: 'kustomize.toolkit.fluxcd.io',
    resource: 'kustomizations',
    readBy: 'FluxStatusService',
  },
  {
    group: 'helm.toolkit.fluxcd.io',
    resource: 'helmreleases',
    readBy: 'FluxStatusService',
  },
  {
    group: 'source.toolkit.fluxcd.io',
    resource: 'ocirepositories',
    readBy: 'SystemAppsService',
  },
];

function loadClusterRoleRules(): PolicyRule[] {
  const docs = loadAll(readFileSync(MANIFEST, 'utf8')) as ClusterRoleDoc[];
  const role = docs.find((d) => d?.kind === 'ClusterRole');
  expect(role, 'a ClusterRole must exist in serviceaccount.yaml').toBeDefined();
  return role!.rules ?? [];
}

function grantsListOn(
  rules: PolicyRule[],
  group: string,
  resource: string,
): boolean {
  return rules.some(
    (r) =>
      (r.apiGroups ?? []).includes(group) &&
      (r.resources ?? []).includes(resource) &&
      (r.verbs ?? []).includes('list'),
  );
}

describe('marketplace-ui ClusterRole RBAC', () => {
  const rules = loadClusterRoleRules();

  it.each(READS)(
    'grants list on $group/$resource (read by $readBy)',
    ({ group, resource }) => {
      expect(grantsListOn(rules, group, resource)).toBe(true);
    },
  );
});
