/**
 * Shared budget counter contract between the gateway and the worker (card 6.3).
 *
 * Each budget counter is a HASH in Valkey whose key includes the period (day, ISO week starting on
 * Monday, month or year, all UTC; weeks and years since card 33.1). Starting
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

/**
 * Period ID (UTC): `d:2026-11-08`, `w:2026-11-02` (the Monday the ISO week starts on),
 * `m:2026-11` or `y:2026`.
 */
export function budgetPeriodKey(period: BudgetPeriod, at: Date = new Date()): string {
  switch (period) {
    case 'daily':
      return `d:${at.toISOString().slice(0, 10)}`;
    case 'weekly':
      return `w:${budgetPeriodRange('weekly', at).start.toISOString().slice(0, 10)}`;
    case 'monthly':
      return `m:${at.toISOString().slice(0, 7)}`;
    case 'yearly':
      return `y:${String(at.getUTCFullYear())}`;
  }
}

/** Start and end of the current period (UTC); weeks start on Monday 00:00 UTC (ISO 8601). */
export function budgetPeriodRange(
  period: BudgetPeriod,
  at: Date = new Date(),
): { start: Date; end: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  switch (period) {
    case 'daily': {
      const start = new Date(Date.UTC(y, m, at.getUTCDate()));
      return { start, end: new Date(start.getTime() + 86_400_000) };
    }
    case 'weekly': {
      // getUTCDay: Sunday is 0, so Monday-based offset is (day + 6) % 7.
      const start = new Date(Date.UTC(y, m, at.getUTCDate() - ((at.getUTCDay() + 6) % 7)));
      return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
    }
    case 'monthly':
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
    case 'yearly':
      return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  }
}

/** `Daily`, `Weekly`, `Monthly` or `Yearly`, for error messages. */
export const budgetPeriodLabel = (period: BudgetPeriod): string =>
  period.charAt(0).toUpperCase() + period.slice(1);

export const budgetCounterKey = (budgetId: string, periodKey: string): string =>
  `dirouter:budget:${budgetId}:${periodKey}`;

/** Valkey HASH of one quota window of a credential (card 32.6): requests, tokens and usd. */
export const quotaWindowKey = (credentialId: string, windowId: string): string =>
  `dirouter:quota:${credentialId}:${windowId}`;

/** Counter id of a default end-user budget for one end user (card 33.2). */
export const endUserCounterId = (budgetId: string, endUser: string): string =>
  `${budgetId}:eu:${endUser}`;

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

/**
 * Where a budget applies: a key, team or project (card 6.3), the whole organization, a member's
 * keys, a model or a provider of the organization (card 33.1), an end user (card 33.2).
 */
export type BudgetScope =
  | 'key'
  | 'project'
  | 'team'
  | 'organization'
  | 'user'
  | 'model'
  | 'provider'
  | 'end_user'
  /** One model of one key (card 33.3). */
  | 'key_model'
  /** Card 33.4. */
  | 'tag'
  | 'cost_center'
  /** Card 32.6: an upstream provider over every organization it serves, one credential. */
  | 'provider_account'
  | 'credential';

/** Scope id of the limits every end user of an organization gets by default (card 33.2). */
export const END_USER_DEFAULT = '*';

/** Request header naming the end user, next to the `user` field of the body (card 33.2). */
export const END_USER_HEADER = 'x-dirouter-end-user';

/** Request headers of tags (comma separated) and the cost center (card 33.4). */
export const TAGS_HEADER = 'x-dirouter-tags';
export const COST_CENTER_HEADER = 'x-dirouter-cost-center';

/** At most this many tags per request (key defaults first); the rest are dropped. */
export const MAX_TAGS = 10;

/** A tag or cost center: 1 to 64 letters, digits and `._:/-`, starting with a letter or digit. */
export const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;

/** Valid, distinct tags in order, at most {@link MAX_TAGS}; anything else is dropped. */
export function normalizeTags(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const tag = value.trim();
    if (!TAG_PATTERN.test(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

/** Longest end-user id that is attributed; longer ids are not tracked. */
export const END_USER_MAX_LENGTH = 256;

/**
 * An end-user id as DiRouter keeps it: trimmed, 1 to 256 characters, no control characters, and
 * never the reserved default id. Anything else is not attributed to an end user.
 */
export function normalizeEndUser(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (id.length === 0 || id.length > END_USER_MAX_LENGTH || hasControl(id)) return undefined;
  return id === END_USER_DEFAULT ? undefined : id;
}

function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Threshold-crossing event that the worker records in audit_log. */
export interface BudgetAlertEvent {
  budgetId: string;
  organizationId: string;
  scope: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  periodKey: string;
  threshold: number;
  kind: 'usd' | 'tokens';
  spent: string;
  limit: string;
  at: string;
}
