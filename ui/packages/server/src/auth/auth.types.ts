import type { User } from '@librepod/shared';

/** `generation` is set only on the onboarding cookie: the onboarding record's
 * generation it was issued for, so a reset retires every older cookie. */
export type SessionClaims = User & { iat: number; exp: number; generation?: number };
