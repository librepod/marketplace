import * as yaml from 'js-yaml';
import type { ResolvedComponent } from './install-components';

export const COMPONENTS_OCI_REPO = 'oci://ghcr.io/librepod/marketplace/components';

const dump = (doc: unknown): string => yaml.dump(doc, { lineWidth: -1 });

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Files for an install that picked components: one pinned, cosign-verified OCIRepository
 * per component, an ArtifactGenerator that lays them under shared-components/ next to
 * the app, and the app's release re-pointed at the generated artifact with
 * `spec.components` and the components' values added to postBuild.substitute.
 * Throws Error on a non-Kustomization release or a substitute-key collision.
 */
export function renderComponentFiles(
  appName: string,
  components: ResolvedComponent[],
  rendered: { release: string; kustomization: string },
): Record<string, string> {
  const sorted = [...components].sort((a, b) => a.name.localeCompare(b.name));
  const labels = { 'marketplace.io/managed': 'true', 'marketplace.io/app': appName };

  const release = yaml.load(rendered.release) as Doc | undefined;
  if (!release || release.kind !== 'Kustomization') {
    throw new Error(`${appName}: the release template is not a Flux Kustomization, components cannot be composed`);
  }
  release.spec ??= {};
  if (release.spec.components) throw new Error(`${appName}: the release template already sets spec.components`);
  release.spec.sourceRef = { kind: 'ExternalArtifact', name: `marketplace-${appName}` };
  release.spec.components = sorted.map((c) => `../../shared-components/${c.name}`);
  release.spec.postBuild ??= {};
  const substitute: Record<string, string> = (release.spec.postBuild.substitute ??= {});
  const add = (key: string, value: string) => {
    if (key in substitute) throw new Error(`${appName}: substitute key ${key} is already set`);
    substitute[key] = value;
  };
  add('INSTANCE_NAME', appName);
  for (const c of sorted) for (const [k, v] of Object.entries(c.values)) add(k, v);

  const kustomization = yaml.load(rendered.kustomization) as Doc;
  kustomization.resources = [...(kustomization.resources ?? []), 'components.yaml', 'generator.yaml'];

  const sources = sorted.map((c) =>
    dump({
      apiVersion: 'source.toolkit.fluxcd.io/v1',
      kind: 'OCIRepository',
      metadata: {
        name: `marketplace-${appName}-${c.name}`,
        namespace: 'flux-system',
        labels: { ...labels, 'marketplace.io/component': c.name },
      },
      spec: {
        interval: '10m',
        url: `${COMPONENTS_OCI_REPO}/${c.name}`,
        // The pinned tag is the recorded installed version.
        ref: { tag: c.version },
        verify: { provider: 'cosign', secretRef: { name: 'cosign-pub' } },
      },
    }),
  );

  const generator = {
    apiVersion: 'source.extensions.fluxcd.io/v1beta1',
    kind: 'ArtifactGenerator',
    metadata: { name: `marketplace-${appName}`, namespace: 'flux-system', labels },
    spec: {
      sources: [
        { alias: 'app', kind: 'OCIRepository', name: `marketplace-${appName}` },
        ...sorted.map((c) => ({ alias: c.name, kind: 'OCIRepository', name: `marketplace-${appName}-${c.name}` })),
      ],
      artifacts: [
        {
          name: `marketplace-${appName}`,
          originRevision: '@app',
          copy: [
            { from: '@app/', to: '@artifact/' },
            ...sorted.map((c) => ({ from: `@${c.name}/`, to: `@artifact/shared-components/${c.name}/` })),
          ],
        },
      ],
    },
  };

  return {
    'components.yaml': sources.join('---\n'),
    'generator.yaml': dump(generator),
    'release.yaml': dump(release),
    'kustomization.yaml': dump(kustomization),
  };
}
