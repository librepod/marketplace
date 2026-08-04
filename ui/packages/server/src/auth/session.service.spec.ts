import { describe, it, expect, beforeEach } from 'vitest';
import { SessionService } from './session.service';

describe('SessionService', () => {
  let svc: SessionService;

  beforeEach(() => {
    process.env.SESSION_SECRET = 'test-secret-very-long-and-random';
    svc = new SessionService();
  });

  it('round-trips a signed token', () => {
    const token = svc.sign({ sub: 'u1', name: 'Alice', email: 'a@x' });
    const claims = svc.verify(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('u1');
    expect(claims!.name).toBe('Alice');
    expect(claims!.email).toBe('a@x');
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it('rejects a token signed with a different secret', () => {
    const token = svc.sign({ sub: 'u1', name: 'Alice', email: 'a@x' });
    process.env.SESSION_SECRET = 'a-different-secret-also-long';
    const other = new SessionService();
    expect(other.verify(token)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = svc.sign({ sub: 'u1', name: 'Alice', email: 'a@x' });
    const [, sig] = token.split('.');
    const tampered = `${Buffer.from(JSON.stringify({ sub: 'admin', name: 'Alice', email: 'a@x', iat: 0, exp: 9999999999 })).toString('base64url')}.${sig}`;
    expect(svc.verify(tampered)).toBeNull();
  });

  it('rejects an expired token', () => {
    // sign() always sets exp = now + TTL, so forge an expired-but-signed token
    // via the private encoder to exercise the real expiry branch.
    const expired = (svc as any).encode({
      sub: 'u1',
      name: 'Alice',
      email: 'a@x',
      iat: 1000,
      exp: 1001,
    });
    expect(svc.verify(expired)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(svc.verify('garbage')).toBeNull();
    expect(svc.verify('a.b')).toBeNull();
    expect(svc.verify('only-one-part')).toBeNull();
  });

  it('refuses to boot on the committed default secret', () => {
    process.env.SESSION_SECRET = 'NZcbV2j7TK5DZTTEwD/tqssrP8CdDqHrjz/HpHjMJDg=';
    expect(() => new SessionService()).toThrow(/committed default/);
  });

  it('throws if SESSION_SECRET is unset', () => {
    delete process.env.SESSION_SECRET;
    expect(() => new SessionService()).toThrow();
  });
});
