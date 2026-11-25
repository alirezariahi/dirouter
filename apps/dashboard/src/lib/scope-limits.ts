/** Form helpers for team and project limits (card 25.5); bounds mirror the limits API. */
import type {
  LimitsControllerList200Item,
  LimitsControllerSetBody,
  LimitsControllerSetBodyBudgetsItem,
} from '../api/generated';

export type ScopeLimit = LimitsControllerList200Item;

export interface LimitDraft {
  rpm: string;
  tpm: string;
  maxConcurrency: string;
  dailyUsd: string;
  dailyTokens: string;
  monthlyUsd: string;
  monthlyTokens: string;
  thresholds: string;
}

const USD = /^\d{1,10}(\.\d{1,8})?$/;
const INTEGER = /^[1-9]\d{0,9}$/;

export function limitDraft(limit: ScopeLimit | undefined): LimitDraft {
  const daily = limit?.budgets.find((b) => b.period === 'daily');
  const monthly = limit?.budgets.find((b) => b.period === 'monthly');
  const value = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
  return {
    rpm: value(limit?.rpm),
    tpm: value(limit?.tpm),
    maxConcurrency: value(limit?.maxConcurrency),
    dailyUsd: daily?.limitUsd ?? '',
    dailyTokens: value(daily?.limitTokens),
    monthlyUsd: monthly?.limitUsd ?? '',
    monthlyTokens: value(monthly?.limitTokens),
    thresholds: (daily ?? monthly)?.alertThresholds.join(', ') ?? '50, 80, 100',
  };
}

/** Field the draft fails on, as `{ field, rule }`, or the request body for PUT limits. */
export function limitBody(
  draft: LimitDraft,
):
  | { ok: true; body: LimitsControllerSetBody }
  | { ok: false; field: keyof LimitDraft; rule: 'integer' | 'usd' | 'thresholds' } {
  for (const field of ['rpm', 'tpm', 'maxConcurrency', 'dailyTokens', 'monthlyTokens'] as const)
    if (draft[field].trim() && !INTEGER.test(draft[field].trim()))
      return { ok: false, field, rule: 'integer' };
  for (const field of ['dailyUsd', 'monthlyUsd'] as const) {
    const v = draft[field].trim();
    if (v && (!USD.test(v) || Number(v) <= 0)) return { ok: false, field, rule: 'usd' };
  }
  const thresholds = draft.thresholds
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (thresholds.length > 10 || thresholds.some((n) => !Number.isInteger(n) || n < 1 || n > 100))
    return { ok: false, field: 'thresholds', rule: 'thresholds' };
  const int = (v: string) => (v.trim() ? Number(v.trim()) : null);
  const budgets: LimitsControllerSetBodyBudgetsItem[] = [];
  for (const period of ['daily', 'monthly'] as const) {
    const usd = draft[`${period}Usd`].trim();
    const tokens = draft[`${period}Tokens`].trim();
    if (!usd && !tokens) continue;
    budgets.push({
      period,
      ...(usd ? { limitUsd: usd } : {}),
      ...(tokens ? { limitTokens: Number(tokens) } : {}),
      ...(thresholds.length
        ? { alertThresholds: [...new Set(thresholds)].sort((a, b) => a - b) }
        : {}),
    });
  }
  return {
    ok: true,
    body: {
      rpm: int(draft.rpm),
      tpm: int(draft.tpm),
      maxConcurrency: int(draft.maxConcurrency),
      budgets,
    },
  };
}
