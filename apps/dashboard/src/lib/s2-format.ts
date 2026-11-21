/** List normalisation and number/currency formatting shared by the Sprint 2 pages. */
import { useSettings } from '../settings';
import { formatNumber } from './date';

/** Accepts either a bare array or `{ items: [...] }`, the two list shapes the API returns. */
export function listOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const items = (value as { items?: unknown } | null | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

/** Below this, an amount is shown as "less than" instead of a row of zeros. */
export const USD_FLOOR = 0.000001;

/**
 * US-dollar amount in the given locale. Amounts of a dollar or more use cents; smaller ones keep
 * four decimals; non-zero amounts that four decimals would round to zero keep two significant
 * digits (`$0.000012`), and anything below a millionth of a dollar reads `<$0.000001`. The same
 * rules apply to both locales; only digits and symbols differ.
 */
export function formatUsd(value: number | string, lang: 'fa' | 'en'): string {
  const v = Number(value);
  const currency = { style: 'currency', currency: 'USD' } as const;
  if (!Number.isFinite(v)) return formatNumber(0, lang, { ...currency, maximumFractionDigits: 2 });
  const abs = Math.abs(v);
  if (abs === 0 || abs >= 1)
    return formatNumber(v, lang, { ...currency, maximumFractionDigits: 2 });
  if (abs >= 0.00005) return formatNumber(v, lang, { ...currency, maximumFractionDigits: 4 });
  if (abs < USD_FLOOR) {
    const floor = formatNumber(USD_FLOOR, lang, { ...currency, maximumFractionDigits: 6 });
    // U+200E keeps "<$0.000001" in reading order inside right-to-left text.
    return `\u200e${v < 0 ? '>-' : '<'}${floor}`;
  }
  return formatNumber(v, lang, { ...currency, maximumSignificantDigits: 2 });
}

export function useFormat() {
  const settings = useSettings();
  const n = (value: number, options: Intl.NumberFormatOptions = {}) =>
    formatNumber(value, settings.lang, options);
  return {
    settings,
    n,
    usd: (value: number | string) => formatUsd(value, settings.lang),
    percent: (ratio: number) => n(ratio, { style: 'percent', maximumFractionDigits: 1 }),
  };
}
