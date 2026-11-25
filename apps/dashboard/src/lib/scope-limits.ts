/**
 * Form helpers for shared limits (card 25.5; organization, member, model and provider scopes and
 * weekly and yearly budgets since card 33.1); bounds mirror the limits API.
 */
import type {
  LimitsControllerList200Item,
  LimitsControllerSetBody,
  LimitsControllerSetBodyBudgetsItem,
} from '../api/generated';

export type ScopeLimit = LimitsControllerList200Item;

export const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
export type Period = (typeof PERIODS)[number];

export interface LimitDraft {
  rpm: string;
  tpm: string;
  inputTpm: string;
  outputTpm: string;
  maxConcurrency: string;
  dailyUsd: string;
  dailyTokens: string;
  weeklyUsd: string;
  weeklyTokens: string;
  monthlyUsd: string;
  monthlyTokens: string;
  yearlyUsd: string;
  yearlyTokens: string;
  thresholds: string;
}

const USD = /^\d{1,10}(\.\d{1,8})?$/;
const INTEGER = /^[1-9]\d{0,9}$/;

export function limitDraft(limit: ScopeLimit | undefined): LimitDraft {
  const of = (period: Period) => limit?.budgets.find((b) => b.period === period);
  const value = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
  return {
    rpm: value(limit?.rpm),
    tpm: value(limit?.tpm),
    inputTpm: value(limit?.inputTpm),
    outputTpm: value(limit?.outputTpm),
    maxConcurrency: value(limit?.maxConcurrency),
    dailyUsd: of('daily')?.limitUsd ?? '',
    dailyTokens: value(of('daily')?.limitTokens),
    weeklyUsd: of('weekly')?.limitUsd ?? '',
    weeklyTokens: value(of('weekly')?.limitTokens),
    monthlyUsd: of('monthly')?.limitUsd ?? '',
    monthlyTokens: value(of('monthly')?.limitTokens),
    yearlyUsd: of('yearly')?.limitUsd ?? '',
    yearlyTokens: value(of('yearly')?.limitTokens),
    thresholds: limit?.budgets[0]?.alertThresholds.join(', ') ?? '50, 80, 100',
  };
}

/** Field the draft fails on, as `{ field, rule }`, or the request body for PUT limits. */
export function limitBody(
  draft: LimitDraft,
):
  | { ok: true; body: LimitsControllerSetBody }
  | { ok: false; field: keyof LimitDraft; rule: 'integer' | 'usd' | 'thresholds' } {
  for (const field of [
    'rpm',
    'tpm',
    'inputTpm',
    'outputTpm',
    'maxConcurrency',
    'dailyTokens',
    'weeklyTokens',
    'monthlyTokens',
    'yearlyTokens',
  ] as const)
    if (draft[field].trim() && !INTEGER.test(draft[field].trim()))
      return { ok: false, field, rule: 'integer' };
  for (const field of ['dailyUsd', 'weeklyUsd', 'monthlyUsd', 'yearlyUsd'] as const) {
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
  for (const period of PERIODS) {
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
      inputTpm: int(draft.inputTpm),
      outputTpm: int(draft.outputTpm),
      maxConcurrency: int(draft.maxConcurrency),
      budgets,
    },
  };
}
