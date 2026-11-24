/** Shapes the billing API returns and the pure rules the billing pages apply to them. */
import { useQuery } from '@tanstack/react-query';

import { api } from '../../lib/api';

export interface CustomerWallet {
  organizationId: string;
  name: string;
  slug: string;
  prepaid: boolean;
  walletId: string | null;
  balanceUsd: string;
}

/** Every customer organization with its balance (shared by several billing pages). */
export function useCustomers(orgId: string) {
  return useQuery({
    queryKey: ['billing', orgId, 'wallets'],
    queryFn: () => api<CustomerWallet[]>(`/orgs/${orgId}/billing/wallets`),
    enabled: Boolean(orgId),
  });
}

// ───────────── Gift codes ─────────────

export interface Batch {
  id: string;
  name: string;
  kind: 'gift' | 'recharge';
  amountUsd: string;
  maxRedemptions: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  codes: number;
  redemptions: number;
  creditedUsd: string;
}

export function batchState(b: Batch, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (b.revokedAt) return 'revoked';
  if (b.expiresAt && new Date(b.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

export const CODE_HEADER = [
  'code',
  'batch_id',
  'batch',
  'kind',
  'amount_usd',
  'max_redemptions',
  'expires_at',
] as const;

/** The created codes as CSV rows: one line per code with what it is worth. */
export function codeRows(batch: Batch, codes: readonly string[]) {
  return codes.map((code) => [
    code,
    batch.id,
    batch.name,
    batch.kind,
    batch.amountUsd,
    String(batch.maxRedemptions),
    batch.expiresAt ?? '',
  ]);
}

// ───────────── Gateway settings ─────────────

export const PROVIDERS = ['zarinpal', 'stripe'] as const;
export type Provider = (typeof PROVIDERS)[number];
const DECIMAL = /^\d{1,10}(\.\d{1,8})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export interface BillingSettings {
  exchangeRates: Record<string, string>;
  topup: { minUsd: string; maxUsd: string };
  providers: Provider[];
  portal: { signupEnabled: boolean; welcomeCreditUsd: string };
  available: Provider[];
}
export interface SettingsDraft {
  providers: Provider[];
  rates: { currency: string; rate: string }[];
  minUsd: string;
  maxUsd: string;
  signupEnabled: boolean;
  welcomeCreditUsd: string;
}

export const draftOf = (s: BillingSettings): SettingsDraft => ({
  providers: s.providers,
  rates: Object.entries(s.exchangeRates).map(([currency, rate]) => ({ currency, rate })),
  minUsd: s.topup.minUsd,
  maxUsd: s.topup.maxUsd,
  signupEnabled: s.portal.signupEnabled,
  welcomeCreditUsd: s.portal.welcomeCreditUsd,
});

export type SettingsProblem = 'currency' | 'rate' | 'amount' | 'limits' | 'irr';

/** The PUT body, or the first thing the API (or Zarinpal) would refuse it for. */
export function settingsBody(
  draft: SettingsDraft,
): { body: Omit<BillingSettings, 'available'> } | { problem: SettingsProblem } {
  const rates: Record<string, string> = {};
  for (const r of draft.rates) {
    const currency = r.currency.trim().toUpperCase();
    const rate = r.rate.trim();
    if (!currency && !rate) continue;
    if (!CURRENCY.test(currency)) return { problem: 'currency' };
    if (!DECIMAL.test(rate) || Number(rate) <= 0) return { problem: 'rate' };
    rates[currency] = rate;
  }
  const minUsd = draft.minUsd.trim();
  const maxUsd = draft.maxUsd.trim();
  const welcomeCreditUsd = draft.welcomeCreditUsd.trim();
  if (![minUsd, maxUsd, welcomeCreditUsd].every((v) => DECIMAL.test(v)))
    return { problem: 'amount' };
  if (Number(minUsd) > Number(maxUsd)) return { problem: 'limits' };
  if (draft.providers.includes('zarinpal') && !rates.IRR) return { problem: 'irr' };
  return {
    body: {
      exchangeRates: rates,
      topup: { minUsd, maxUsd },
      providers: draft.providers,
      portal: { signupEnabled: draft.signupEnabled, welcomeCreditUsd },
    },
  };
}
