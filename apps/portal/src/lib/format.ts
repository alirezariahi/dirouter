/** USD with as many decimals as the amount needs (per-token prices are tiny); strings, no floats. */
export function usd(value: string | null | undefined, minDecimals = 2): string {
  if (value === null || value === undefined) return '—';
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const trimmed = fraction.replace(/0+$/, '').padEnd(minDecimals, '0');
  return `${negative ? '-' : ''}$${whole}${trimmed ? `.${trimmed}` : ''}`;
}

export const date = (iso: string, lang: 'fa' | 'en') =>
  new Date(iso).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
