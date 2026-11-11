/**
 * Shared budget counter contract between the gateway and the worker (card 6.3).
 *
 * Each budget counter is a HASH in Valkey whose key includes the period (day or month, UTC). Starting
 * a new period means a new key, so the reset is automatic and the old key is removed by its TTL.
 * Fields:
 * - `usd`: cost in units of 1e-8 dollars, integer (same precision as the Decimal(18,8) ledger, no float error)
 * - `tokens`: input + output tokens
 * - `ts`: time of the last increment (ms)
 */
import type { BudgetPeriod } from './config-snapshot.js';

export const BUDGET_UNITS_PER_USD = 100_000_000;

/** Valkey list of threshold-crossing events (gateway LPUSH, worker consumes). */
export const BUDGET_ALERTS_KEY = 'dirouter:budget:alerts';

/** Period ID: `d:2026-11-08` or `m:2026-11` (UTC). */
export function budgetPeriodKey(period: BudgetPeriod, at: Date = new Date()): string {
  const iso = at.toISOString();
  return period === 'daily' ? `d:${iso.slice(0, 10)}` : `m:${iso.slice(0, 7)}`;
}

/** Start and end of the current period (UTC). */
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

/** Decimal dollar string (e.g. `"0.00012345"`) → integer units of 1e-8, without float. */
export function usdToUnits(usd: string): number {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(usd.trim());
  if (!match) return 0;
  const [, sign = '', whole = '0', frac = ''] = match;
  const units =
    Number(whole || '0') * BUDGET_UNITS_PER_USD + Number(frac.padEnd(8, '0').slice(0, 8));
  return sign === '-' ? -units : units;
}

export const unitsToUsd = (units: number): string => (units / BUDGET_UNITS_PER_USD).toFixed(8);

/** Threshold-crossing event that the worker records in audit_log. */
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
