import { vi } from 'vitest';
import type { CasdoorSession } from '../../src/onboarding/casdoor-admin.service';

/** Casdoor's built-in admin and the platform org's users, in memory: the slice of
 * CasdoorAdminService onboarding uses. Starts at the factory password "123". */
export function fakeCasdoor(adminPassword = '123') {
  const state = { adminPassword, users: new Map<string, string>() };
  const casdoor = {
    factoryPassword: '123',
    reachable: vi.fn(async () => true),
    signIn: vi.fn(async (candidates: string[]): Promise<CasdoorSession | null> => {
      const password = candidates.find((p) => p !== '' && p === state.adminPassword);
      return password ? { cookie: 'casdoor_session_id=fake', password } : null;
    }),
    setAdminPassword: vi.fn(async (_session: CasdoorSession, password: string) => {
      state.adminPassword = password;
    }),
    ensureOrganization: vi.fn(async () => undefined),
    getUser: vi.fn(async (_session: CasdoorSession, name: string) => (state.users.has(name) ? { name } : null)),
    addUser: vi.fn(async (_session: CasdoorSession, name: string, password: string) => {
      state.users.set(name, password);
    }),
    setUserPassword: vi.fn(async (_session: CasdoorSession, name: string, password: string) => {
      state.users.set(name, password);
    }),
  };
  return { casdoor, state };
}
