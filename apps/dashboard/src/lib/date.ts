/** تاریخ شمسی/میلادی با Intl بومی (بدون کتابخانه، تا bundle کوچک بماند). */
export type Calendar = 'persian' | 'gregory';

export function formatDate(
  value: Date | string | number,
  opts: { calendar: Calendar; lang: 'fa' | 'en'; time?: boolean },
): string {
  const date = value instanceof Date ? value : new Date(value);
  const locale = `${opts.lang === 'fa' ? 'fa-IR' : 'en-US'}-u-ca-${opts.calendar}${opts.lang === 'fa' ? '-nu-arabext' : ''}`;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(opts.time ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'Asia/Tehran',
  }).format(date);
}

export function formatNumber(
  value: number,
  lang: 'fa' | 'en',
  opts: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US', opts).format(value);
}
