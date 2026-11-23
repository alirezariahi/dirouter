/** The signed-in workspace's prepaid wallet. */
import { useQuery } from '@tanstack/react-query';

import { api } from './api';
import { orgId } from './session';

export interface WalletSummary {
  prepaid: boolean;
  wallet: { id: string; balanceUsd: string; heldUsd: string; availableUsd: string } | null;
}

export const useWallet = () =>
  useQuery({
    queryKey: ['wallet', orgId()],
    queryFn: () => api<WalletSummary>(`/orgs/${orgId()}/wallet`),
  });
