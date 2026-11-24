/**
 * Persian formatting for invoices (card 26.1): Jalali dates and Persian digits.
 * Dates use the ICU Persian calendar built into Node (full ICU is the default since Node 13).
 */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const THOUSANDS = '٬';
const DECIMAL = '٫';

/** ASCII digits to Persian digits (other characters unchanged). */
export function faDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS);
}

/** A whole number (bigint or digit string) with Persian digits and thousands separators. */
export function faInteger(value: bigint | number | string): string {
  const text = String(value);
  const negative = text.startsWith('-');
  return `${negative ? '-' : ''}${faDigits(group(text.replace(/^-/, '')))}`;
}

/** An exact decimal (as many decimals as it needs, at least `min`) in Persian digits. */
export function faDecimal(amount: string, min = 2): string {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = amount.replace(/^-/, '').split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(min, '0');
  const body = `${group(whole.replace(/^0+(?=\d)/, ''))}${digits ? DECIMAL + digits : ''}`;
  return `${negative ? '-' : ''}${faDigits(body)}`;
}

/** Exact USD in ASCII digits, as the API shows it (`$17.625`). */
export function money(amount: string): string {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = amount.replace(/^-/, '').split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${negative ? '-' : ''}$${whole}.${digits}`;
}

const jalaliFormat = new Map<string, Intl.DateTimeFormat>();

/** A Jalali (Solar Hijri) date such as `۱۴۰۵/۰۹/۰۳`, in the given time zone. */
export function jalaliDate(date: Date, timeZone = 'Asia/Tehran'): string {
  let format = jalaliFormat.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    });
    jalaliFormat.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  return faDigits(`${parts.year ?? ''}/${parts.month ?? ''}/${parts.day ?? ''}`);
}

/** First and last day of a UTC month (`YYYY-MM`) as Jalali dates. */
export function jalaliPeriod(period: string): { from: string; to: string } {
  const [year = 0, month = 1] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1, 12));
  const last = new Date(Date.UTC(year, month, 0, 12));
  return { from: jalaliDate(start, 'UTC'), to: jalaliDate(last, 'UTC') };
}
