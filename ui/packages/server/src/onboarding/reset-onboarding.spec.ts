import { describe, it, expect, vi } from 'vitest';
import { runReset } from './reset-onboarding';

describe('reset-onboarding', () => {
  it('prints the new setup code and exits 0', async () => {
    const out = { log: vi.fn(), error: vi.fn() };
    expect(await runReset({ reset: vi.fn(async () => '7KQMX3RT9VHC') }, out)).toBe(0);
    expect(out.log).toHaveBeenCalledWith(
      "LibrePod setup code: 7KQM-X3RT-9VHC — onboarding is open again; open http://<this device's IP> to continue",
    );
  });

  it('exits non-zero with the reason, and never prints a code, when OpenBao is unreachable', async () => {
    const out = { log: vi.fn(), error: vi.fn() };
    expect(await runReset({ reset: vi.fn(async () => { throw new Error('OpenBao unreachable: ECONNREFUSED'); }) }, out)).toBe(1);
    expect(out.error).toHaveBeenCalledWith('reset-onboarding failed: OpenBao unreachable: ECONNREFUSED');
    expect(out.log).not.toHaveBeenCalled();
  });
});
