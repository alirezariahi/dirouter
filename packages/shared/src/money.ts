/**
 * پول با BigInt fixed-point (۸ رقم اعشار، معادل Decimal(18,8)).
 *
 * واحد داخلی «نانو-سنت»ی است که ۱ دلار = ۱۰^۸ واحد. هیچ عددی از نوع float در
 * محاسبهٔ پول استفاده نمی‌شود؛ ورودی و خروجی رشتهٔ اعشاری است.
 */

export const USD_SCALE = 8;
const FACTOR = 10n ** BigInt(USD_SCALE);
const PATTERN = /^(-)?(\d+)(?:\.(\d{1,8}))?$/;

/** مبلغ دلاری به واحد داخلی (۱ دلار = ۱۰^۸). */
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

/** تقسیم با گرد کردن half-up (برای مقادیر نامنفی). */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/** هزینهٔ `tokens` توکن با قیمت دلاری به ازای یک میلیون توکن. */
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

/** درصد مصرف (عدد صحیح، رو به پایین) برای آستانه‌های هشدار. */
export function percentOf(used: UsdUnits, limit: UsdUnits): number {
  if (limit <= 0n) return 100;
  return Number((used * 100n) / limit);
}
