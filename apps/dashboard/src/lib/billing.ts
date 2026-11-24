/**
 * Billing pages (cards 25.1, 25.2): who may see them and small money helpers. The pages exist only
 * on the platform organization and need `billing:read` (changes need `billing:write`). The server
 * answers 404 to every other organization, so this keeps the menu honest rather than secure.
 */
import { can, currentOrg, type SessionUser, useSession } from './session';

type Org = SessionUser['organizations'][number];

export function billingAccess(org: Pick<Org, 'role' | 'permissions' | 'isPlatform'> | undefined) {
  const platform = org?.isPlatform === true;
  return {
    visible: platform && can(org, 'billing:read'),
    write: platform && can(org, 'billing:write'),
  };
}

export function useBillingAccess() {
  const user = useSession();
  const org = currentOrg();
  const member = user?.organizations.find((o) => o.id === org?.id);
  return { orgId: org?.id ?? '', ...billingAccess(member) };
}

/** A USD amount as the ledger accepts it: up to 10 digits and 8 decimals, optionally signed. */
export const USD_PATTERN = /^-?\d{1,10}(\.\d{1,8})?$/;

/** `"-12.50000000"` → `"-12.5"`: the exact ledger figure without trailing zeros. */
export function trimUsd(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

const SCALE = 100_000_000n;

/** A ledger string in 10⁻⁸ dollar units, so sums stay exact (no floating point). */
export function usdUnits(value: string): bigint {
  const negative = value.trim().startsWith('-');
  const [whole = '0', fraction = ''] = value.trim().replace(/^[-+]/, '').split('.');
  const units = BigInt(whole || '0') * SCALE + BigInt(fraction.padEnd(8, '0').slice(0, 8));
  return negative ? -units : units;
}

export function unitsToUsd(units: bigint): string {
  const abs = units < 0n ? -units : units;
  const fraction = (abs % SCALE).toString().padStart(8, '0');
  return `${units < 0n ? '-' : ''}${(abs / SCALE).toString()}.${fraction}`;
}

export function sumUsd(values: readonly string[]): string {
  return unitsToUsd(values.reduce((sum, v) => sum + usdUnits(v), 0n));
}

/** amount × multiplier, rounded half up to 8 decimals like the gateway's sale price. */
export function multiplyUsd(amount: string, multiplier: string): string {
  const product = usdUnits(amount) * usdUnits(multiplier);
  const half = product < 0n ? -SCALE / 2n : SCALE / 2n;
  return unitsToUsd((product + half) / SCALE);
}

/** `[from, to)` in whole UTC days for a picker that shows `to` inclusive. */
export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return isoDay(d);
}

/** A fresh idempotency key for one money form; a retry of the same submission reuses it. */
export function idempotencyKey(): string {
  return `dash-${crypto.randomUUID()}`;
}

/** The date as `YYYY-MM-DD` in UTC, like the API's day boundaries. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
