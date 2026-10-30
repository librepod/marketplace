import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { renderComponentFiles } from './component-files';
import type { ResolvedComponent } from './install-components';

const RELEASE = `apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: marketplace-immich
  namespace: flux-system
spec:
  interval: 10m
  path: ./overlays/librepod
  sourceRef:
    kind: OCIRepository
    name: marketplace-immich
  postBuild:
    substitute:
      BASE_DOMAIN: "libre.pod"
`;
const KUSTOMIZATION = `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - source.yaml
  - release.yaml
`;
const rendered = { release: RELEASE, kustomization: KUSTOMIZATION };

const frp: ResolvedComponent = {
  name: 'frp-expose',
  version: '1.0.0',
  hasSettings: false,
  settings: {},
  values: { FRP_EXPOSE_HOST: 'h.svc', FRP_EXPOSE_PORT: '2283', FRP_EXPOSE_SUBDOMAIN: 'immich' },
};
const ts: ResolvedComponent = {
  name: 'tailscale',
  version: 'v1.104.2',
  hasSettings: true,
  settings: { TS_AUTHKEY: 'k' },
  values: { TS_HOSTNAME: 'immich' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const docs = (text: string): any[] => yaml.loadAll(text);

describe('renderComponentFiles', () => {
  it('renders one pinned, verified OCIRepository per component', () => {
    const files = renderComponentFiles('immich', [frp], rendered);
    const [repo] = docs(files['components.yaml']);
    expect(repo.metadata.name).toBe('marketplace-immich-frp-expose');
    expect(repo.metadata.namespace).toBe('flux-system');
    expect(repo.spec.ref.tag).toBe('1.0.0');
    expect(repo.spec.url).toBe('oci://ghcr.io/librepod/marketplace/components/frp-expose');
    expect(repo.spec.verify.secretRef.name).toBe('cosign-pub');
    expect(repo.metadata.labels).toMatchObject({
      'marketplace.io/app': 'immich',
      'marketplace.io/component': 'frp-expose',
    });
  });

  it('renders the generator', () => {
    const [gen] = docs(renderComponentFiles('immich', [frp], rendered)['generator.yaml']);
    expect(gen.kind).toBe('ArtifactGenerator');
    expect(gen.spec.sources.map((s: { alias: string }) => s.alias)).toEqual(['app', 'frp-expose']);
    expect(gen.spec.artifacts[0].originRevision).toBe('@app');
    expect(gen.spec.artifacts[0].copy.map((c: { to: string }) => c.to)).toEqual([
      '@artifact/',
      '@artifact/shared-components/frp-expose/',
    ]);
  });

  it('patches the release', () => {
    const [rel] = docs(renderComponentFiles('immich', [frp], rendered)['release.yaml']);
    expect(rel.spec.sourceRef).toEqual({ kind: 'ExternalArtifact', name: 'marketplace-immich' });
    expect(rel.spec.components).toEqual(['../../shared-components/frp-expose']);
    expect(rel.spec.postBuild.substitute).toEqual({
      BASE_DOMAIN: 'libre.pod',
      INSTANCE_NAME: 'immich',
      FRP_EXPOSE_HOST: 'h.svc',
      FRP_EXPOSE_PORT: '2283',
      FRP_EXPOSE_SUBDOMAIN: 'immich',
    });
  });

  it('appends the new files to kustomization resources', () => {
    const [k] = docs(renderComponentFiles('immich', [frp], rendered)['kustomization.yaml']);
    expect(k.resources).toEqual(['source.yaml', 'release.yaml', 'components.yaml', 'generator.yaml']);
  });

  it('sorts two components by name', () => {
    const files = renderComponentFiles('immich', [ts, frp], rendered);
    expect(docs(files['components.yaml']).map((d) => d.metadata.labels['marketplace.io/component'])).toEqual([
      'frp-expose',
      'tailscale',
    ]);
    expect(docs(files['release.yaml'])[0].spec.components).toEqual([
      '../../shared-components/frp-expose',
      '../../shared-components/tailscale',
    ]);
    expect(docs(files['generator.yaml'])[0].spec.sources.map((s: { alias: string }) => s.alias)).toEqual([
      'app',
      'frp-expose',
      'tailscale',
    ]);
  });

  it('throws on a non-Kustomization release', () => {
    const helm = { release: 'apiVersion: helm.toolkit.fluxcd.io/v2\nkind: HelmRelease\nspec: {}\n', kustomization: KUSTOMIZATION };
    expect(() => renderComponentFiles('immich', [frp], helm)).toThrow(/Kustomization/);
  });

  it('throws on a substitute-key collision', () => {
    const clash = { ...ts, values: { BASE_DOMAIN: 'x' } };
    expect(() => renderComponentFiles('immich', [clash], rendered)).toThrow(/BASE_DOMAIN/);
  });
});
