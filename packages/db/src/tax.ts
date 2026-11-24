/**
 * Invoice tax arithmetic (card 26.1), pure so it is unit-tested without a database.
 *
 * Charges include VAT: what the customer paid for services (gross) is split into net + VAT at the
 * rate in force when the invoice is issued. USD amounts are ledger units (1 USD = 10^8); rials are
 * whole rials. Rounding is half up and every split adds up exactly.
 */
import { fromUnits, LedgerError, toUnits } from './ledger.js';

const PERCENT = /^(\d{1,2})(?:\.(\d{1,2}))?$/;
const RATE = /^(\d{1,10})(?:\.(\d{1,8}))?$/;

/** A VAT rate such as `"10"` or `"9.5"` to hundredths of a percent; [0, 100). */
export function percentToBasisPoints(percent: string): bigint {
  const match = PERCENT.exec(percent.trim());
  if (!match) throw new LedgerError('invalid_amount', `invalid VAT percent: ${percent}`);
  return BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

/** a / b rounded half up, for non-negative a and positive b. */
function divRound(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (2n * b);
}

export interface VatSplit {
  grossUsd: string;
  netUsd: string;
  vatUsd: string;
}

/** Splits a VAT-inclusive amount into net and VAT; net + VAT is exactly gross. */
export function splitVat(grossUsd: string, vatPercent: string): VatSplit {
  const gross = toUnits(grossUsd);
  if (gross < 0n) throw new LedgerError('invalid_amount', 'a taxable amount cannot be negative');
  const bp = percentToBasisPoints(vatPercent);
  const vat = divRound(gross * bp, 10_000n + bp);
  return { grossUsd: fromUnits(gross), netUsd: fromUnits(gross - vat), vatUsd: fromUnits(vat) };
}

/**
 * Shares `total` between parts in proportion to `weights` (largest remainder), so the shares are
 * whole units and add up to `total` exactly. Used to spread VAT and rials over invoice lines.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((s, w) => s + w, 0n);
  if (weights.some((w) => w < 0n)) throw new RangeError('weights cannot be negative');
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0n));
  const shares = weights.map((w) => (total * w) / sum);
  const remainders = weights
    .map((w, i) => ({ i, r: (total * w) % sum }))
    .sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  let left = total - shares.reduce((s, v) => s + v, 0n);
  for (const { i } of remainders) {
    if (left <= 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left--;
  }
  return shares;
}

/** Whole rials for a USD amount at `rate` rials per USD, rounded half up (sign kept). */
export function usdToRials(amountUsd: string, rate: string): bigint {
  const match = RATE.exec(rate.trim());
  if (!match) throw new LedgerError('invalid_amount', `invalid exchange rate: ${rate}`);
  const rateUnits = BigInt(match[1] ?? '0') * 10n ** 8n + BigInt((match[2] ?? '').padEnd(8, '0'));
  const units = toUnits(amountUsd);
  const abs = units < 0n ? -units : units;
  const rials = divRound(abs * rateUnits, 10n ** 16n);
  return units < 0n ? -rials : rials;
}

export interface RialTotals {
  grossRials: bigint;
  vatRials: bigint;
  netRials: bigint;
}

/** The invoice's totals in rials; net is gross − VAT so the rial figures add up too. */
export function rialTotals(split: VatSplit, rate: string): RialTotals {
  const grossRials = usdToRials(split.grossUsd, rate);
  const vatRials = usdToRials(split.vatUsd, rate);
  return { grossRials, vatRials, netRials: grossRials - vatRials };
}
