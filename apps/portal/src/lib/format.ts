/** USD with as many decimals as the amount needs (per-token prices are tiny); strings, no floats. */
export function usd(value: string | null | undefined, minDecimals = 2): string {
  if (value === null || value === undefined) return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const trimmed = fraction.replace(/0+$/, '').padEnd(minDecimals, '0');
  return `${negative ? '-' : ''}$${whole}${trimmed ? `.${trimmed}` : ''}`;
}

/** A whole number with the language's digits and grouping (tokens, request counts). */
export const count = (value: number, lang: 'fa' | 'en') =>
  value.toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US');

/** A UTC day (`YYYY-MM-DD`) in the language's calendar: Jalali in Persian. */
export const day = (iso: string, lang: 'fa' | 'en') =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString(lang === 'fa' ? 'fa-IR' : 'en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export const date = (iso: string, lang: 'fa' | 'en') =>
  new Date(iso).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
