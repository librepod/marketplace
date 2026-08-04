import type { User } from '@librepod/shared';

export type SessionClaims = User & { iat: number; exp: number };
