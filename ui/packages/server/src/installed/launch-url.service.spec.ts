import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { LaunchUrlService } from './launch-url.service';

const mockListNamespacedCustomObject = vi.fn();
vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn().mockImplementation(() => ({
    loadFromCluster: vi.fn(),
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn().mockReturnValue({
      listNamespacedCustomObject: mockListNamespacedCustomObject,
    }),
  })),
  CustomObjectsApi: vi.fn(),
}));

// Build an IngressRoute custom object with a Host() match and optional annotation.
function ingressRoute(
  name: string,
  host: string,
  launchAnnotation?: string,
) {
  return {
    metadata: {
      name,
      ...(launchAnnotation !== undefined
        ? { annotations: { 'librepod.dev/launch': launchAnnotation } }
        : {}),
    },
    spec: { routes: [{ kind: 'Rule', match: `Host(\`${host}\`)` }] },
  };
}

describe('LaunchUrlService', () => {
  let service: LaunchUrlService;
  let module: TestingModule;

  beforeEach(async () => {
    vi.clearAllMocks();
    module = await Test.createTestingModule({
      providers: [LaunchUrlService],
    }).compile();
    service = module.get<LaunchUrlService>(LaunchUrlService);
    await module.init();
  });

  afterEach(async () => {
    await module.close();
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('returns { url } for a single annotated route (LiteLLM /ui)', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({
      items: [ingressRoute('litellm', 'litellm.example.com', '/ui')],
    });

    const res = await service.resolve('litellm');

    expect(res).toEqual({ url: 'https://litellm.example.com/ui' });
  });

  it('returns {} when a route exists but none is annotated (fall back)', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({
      items: [ingressRoute('whoami', 'whoami.example.com')],
    });

    const res = await service.resolve('whoami');

    expect(res).toEqual({});
  });

  it('returns { launchable: false } when the namespace has NO IngressRoutes (rustdesk)', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({ items: [] });

    const res = await service.resolve('rustdesk-server-oss');

    expect(res).toEqual({ launchable: false });
  });

  it('returns {} on k8s error and never sets launchable:false (outage never suppresses)', async () => {
    mockListNamespacedCustomObject.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await service.resolve('litellm');

    expect(res).toEqual({});
    expect(res.launchable).not.toBe(false);
  });

  it('picks the annotated route among several (headscale → headplane host)', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({
      items: [
        ingressRoute('headscale', 'headscale.example.com'),
        ingressRoute('headplane', 'headplane.example.com', '/'),
      ],
    });

    const res = await service.resolve('headscale');

    expect(res).toEqual({ url: 'https://headplane.example.com' });
  });

  it('returns {} when the annotated route has no parseable Host()', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({
      items: [
        {
          metadata: { name: 'x', annotations: { 'librepod.dev/launch': '/ui' } },
          spec: { routes: [{ kind: 'Rule', match: 'PathPrefix(`/`)' }] },
        },
      ],
    });

    const res = await service.resolve('x');

    expect(res).toEqual({});
  });

  it('normalises a path value missing its leading slash', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({
      items: [ingressRoute('app', 'app.example.com', 'ui')],
    });

    const res = await service.resolve('app');

    expect(res).toEqual({ url: 'https://app.example.com/ui' });
  });

  it('treats "/" as host root (no trailing path)', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({
      items: [ingressRoute('app', 'app.example.com', '/')],
    });

    const res = await service.resolve('app');

    expect(res).toEqual({ url: 'https://app.example.com' });
  });

  it('deterministically picks the name-sorted-first when multiple routes are annotated, and warns', async () => {
    const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    mockListNamespacedCustomObject.mockResolvedValueOnce({
      items: [
        ingressRoute('zebra', 'zebra.example.com', '/z'),
        ingressRoute('alpha', 'alpha.example.com', '/a'),
      ],
    });

    const res = await service.resolve('multi');

    expect(res).toEqual({ url: 'https://alpha.example.com/a' });
    expect(warn).toHaveBeenCalled();
  });

  it('scopes the list to the app namespace and the traefik IngressRoute plural', async () => {
    mockListNamespacedCustomObject.mockResolvedValueOnce({ items: [] });

    await service.resolve('litellm');

    expect(mockListNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'traefik.io',
        version: 'v1alpha1',
        namespace: 'litellm',
        plural: 'ingressroutes',
      }),
    );
  });
});
