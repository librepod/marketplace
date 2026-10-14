import { OpenBaoCasMismatchError, type KvEntry } from '../../src/installed/openbao.client';

/** In-memory KV v2 with check-and-set: the slice of OpenBaoClient the onboarding store uses. */
export class FakeKv {
  private readonly entries = new Map<string, KvEntry>();
  /** Set to make every call reject with this error (OpenBao down, sealed, misconfigured). */
  failWith: Error | null = null;

  async readEntry(mount: string, path: string): Promise<KvEntry | null> {
    if (this.failWith) throw this.failWith;
    const entry = this.entries.get(`${mount}/${path}`);
    return entry ? { data: structuredClone(entry.data), version: entry.version } : null;
  }

  async writeEntry(
    mount: string,
    path: string,
    data: Record<string, unknown>,
    opts: { cas?: number } = {},
  ): Promise<void> {
    if (this.failWith) throw this.failWith;
    const key = `${mount}/${path}`;
    const version = this.entries.get(key)?.version ?? 0;
    if (opts.cas !== undefined && opts.cas !== version) {
      throw new OpenBaoCasMismatchError(`write ${key}: the entry changed since it was read`);
    }
    this.entries.set(key, { data: structuredClone(data), version: version + 1 });
  }

  /** The stored data, for assertions. */
  get(mount: string, path: string): Record<string, unknown> | undefined {
    return this.entries.get(`${mount}/${path}`)?.data;
  }
}
