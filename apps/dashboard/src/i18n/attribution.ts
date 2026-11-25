/**
 * Usage by attribution dimension on the Analytics page: end users (card 33.2), tags and cost
 * centers (card 33.4).
 */
import type { Widen } from './s2/types';

export const attributionFa = {
  title: 'مصرف به تفکیک',
  help: 'از جدول‌های تجمیعی هر بُعد؛ هر ساعت حداکثر ۱۰۰۰ مقدار پرمصرف جدا نگه داشته می‌شوند و بقیه زیر «سایر» جمع می‌شوند.',
  dimension: 'بُعد',
  dimensions: { end_user: 'کاربر نهایی', tag: 'برچسب', cost_center: 'مرکز هزینه' },
  filter: 'فقط این مقدار',
  filterHelp: 'با یک مقدار، مصرف همان مقدار به تفکیک مدل نشان داده می‌شود.',
  clear: 'پاک کردن',
  byModel: '«{{value}}» به تفکیک مدل',
  export: 'خروجی CSV',
  other: 'سایر',
  none: 'در این بازه مصرفی با این بُعد نیست.',
  requests: '{{n}} درخواست',
} as const;

export const attributionEn: Widen<typeof attributionFa> = {
  title: 'Usage by',
  help: 'From each dimension’s rollups; every hour keeps the 1000 busiest values apart and sums the rest as “other”.',
  dimension: 'Dimension',
  dimensions: { end_user: 'End user', tag: 'Tag', cost_center: 'Cost center' },
  filter: 'Only this value',
  filterHelp: 'With a value, its usage is shown by model.',
  clear: 'Clear',
  byModel: '“{{value}}” by model',
  export: 'Export CSV',
  other: 'Other',
  none: 'No usage with this dimension in the range.',
  requests: '{{n}} requests',
};
