/**
 * قرارداد مشترک شمارندهٔ بودجه بین گیت‌وی و worker (کارت ۶.۳).
 *
 * شمارندهٔ هر بودجه یک HASH در Valkey است که کلیدش دوره را دارد (روز یا ماه UTC). شروع
 * دورهٔ تازه یعنی کلید تازه، پس ریست خودکار است و کلید قدیمی با TTL پاک می‌شود.
 * فیلدها:
 * - `usd`: هزینه به واحد 1e-8 دلار، عدد صحیح (همان دقت Decimal(18,8) ledger، بدون خطای float)
 * - `tokens`: توکن ورودی + خروجی
 * - `ts`: زمان آخرین افزایش (ms)
 */
import type { BudgetPeriod } from './config-snapshot.js';

export const BUDGET_UNITS_PER_USD = 100_000_000;

/** فهرست Valkey رویدادهای عبور از آستانه (گیت‌وی LPUSH، worker مصرف). */
export const BUDGET_ALERTS_KEY = 'dirouter:budget:alerts';

/** شناسهٔ دوره: `d:2026-11-08` یا `m:2026-11` (UTC). */
export function budgetPeriodKey(period: BudgetPeriod, at: Date = new Date()): string {
  const iso = at.toISOString();
  return period === 'daily' ? `d:${iso.slice(0, 10)}` : `m:${iso.slice(0, 7)}`;
}

/** شروع و پایان دورهٔ جاری (UTC). */
export function budgetPeriodRange(
  period: BudgetPeriod,
  at: Date = new Date(),
): { start: Date; end: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  if (period === 'daily') {
    const start = new Date(Date.UTC(y, m, at.getUTCDate()));
    return { start, end: new Date(start.getTime() + 86_400_000) };
  }
  return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
}

export const budgetCounterKey = (budgetId: string, periodKey: string): string =>
  `dirouter:budget:${budgetId}:${periodKey}`;

/** رشتهٔ دهدهی دلار (مثلاً `"0.00012345"`) → واحد صحیح 1e-8، بدون float. */
export function usdToUnits(usd: string): number {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(usd.trim());
  if (!match) return 0;
  const [, sign = '', whole = '0', frac = ''] = match;
  const units =
    Number(whole || '0') * BUDGET_UNITS_PER_USD + Number(frac.padEnd(8, '0').slice(0, 8));
  return sign === '-' ? -units : units;
}

export const unitsToUsd = (units: number): string => (units / BUDGET_UNITS_PER_USD).toFixed(8);

/** رویداد عبور از آستانه که worker در audit_log ثبت می‌کند. */
export interface BudgetAlertEvent {
  budgetId: string;
  organizationId: string;
  scope: 'key' | 'project' | 'team';
  scopeId: string;
  period: BudgetPeriod;
  periodKey: string;
  threshold: number;
  kind: 'usd' | 'tokens';
  spent: string;
  limit: string;
  at: string;
}
