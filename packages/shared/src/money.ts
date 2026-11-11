/**
 * Money as BigInt fixed-point (8 decimal places, equivalent to Decimal(18,8)).
 *
 * The internal unit is a "nano-cent" where $1 = 10^8 units. No float number is used in
 * money calculations; input and output are decimal strings.
 */

export const USD_SCALE = 8;
const FACTOR = 10n ** BigInt(USD_SCALE);
const PATTERN = /^(-)?(\d+)(?:\.(\d{1,8}))?$/;

/** Dollar amount in internal units (1 dollar = 10^8). */
export type UsdUnits = bigint;

export function parseUsd(amount: string): UsdUnits {
  const match = PATTERN.exec(amount.trim());
  if (!match) throw new TypeError(`invalid USD amount: ${amount}`);
  const [, sign, whole = '0', fraction = ''] = match;
  const units = BigInt(whole) * FACTOR + BigInt(fraction.padEnd(USD_SCALE, '0'));
  return sign ? -units : units;
}

export function formatUsd(units: UsdUnits): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / FACTOR;
  const fraction = (abs % FACTOR).toString().padStart(USD_SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/** Division with half-up rounding (for non-negative values). */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/** Cost of `tokens` tokens at a dollar price per million tokens. */
export function costForTokens(tokens: number, pricePerMTok: string): UsdUnits {
  if (!Number.isSafeInteger(tokens) || tokens < 0)
    throw new RangeError(`invalid tokens: ${tokens}`);
  if (tokens === 0) return 0n;
  return divRound(BigInt(tokens) * parseUsd(pricePerMTok), 1_000_000n);
}

export function sumUsd(values: Iterable<UsdUnits>): UsdUnits {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Usage percentage (integer, rounded down) for alert thresholds. */
export function percentOf(used: UsdUnits, limit: UsdUnits): number {
  if (limit <= 0n) return 100;
  return Number((used * 100n) / limit);
}
