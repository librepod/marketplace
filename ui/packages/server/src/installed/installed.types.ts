import type { AppStatus } from '@librepod/shared';

export type { AppStatus };

export interface FluxCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
}
