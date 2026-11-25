/**
 * Upstream account balances (card 32.9): the gateway looks up the credit left on provider
 * accounts that expose it and pushes one sample per credential to a Valkey list; the worker keeps
 * the latest one per credential in `credential_balances`, where the dashboard and the
 * `upstream_balance_low` alert rule read it.
 */
import { z } from 'zod';

import { IsoDateTime } from './common.js';

/** Valkey list the gateway pushes balance samples to and the worker drains. */
export const UPSTREAM_BALANCES_KEY = 'dirouter:balances:samples';

/** Balance APIs DiRouter knows; a provider names one with `options.balance` or its preset. */
export const BalanceKind = z.enum(['openrouter', 'deepseek', 'moonshot', 'siliconflow']);
export type BalanceKind = z.infer<typeof BalanceKind>;

export const UpstreamBalanceSample = z.object({
  providerId: z.string().min(1),
  credentialId: z.string().min(1),
  kind: BalanceKind,
  ok: z.boolean(),
  /** Credit left, as a decimal string in `currency`. */
  amount: z
    .string()
    .regex(/^-?\d{1,12}(\.\d{1,8})?$/)
    .optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  error: z.string().max(300).optional(),
  checkedAt: IsoDateTime,
});
export type UpstreamBalanceSample = z.infer<typeof UpstreamBalanceSample>;
