import { billing } from '@talyn/client/native';
import type { BillingStatus } from '@talyn/shared';

import { useAuth } from '../../auth/AuthProvider';
import { useRemote } from '../more/useRemote';

/** The account's plan and usage. Account-wide, so it is keyed by the user, not the workspace. */
export function useBillingStatus(enabled = true) {
  const user = useAuth().user?.id ?? null;
  return useRemote<BillingStatus>(enabled && user ? `billing:${user}` : null, () => billing.status(), { intervalMs: 60_000 });
}
