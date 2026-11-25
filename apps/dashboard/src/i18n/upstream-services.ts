/**
 * Native pass-through grants and allow-lists (card 30.7) and upstream balances and channel tests
 * (card 32.9), on the keys and providers pages.
 */
import type { Widen } from './s2/types';

export const upstreamServicesFa = {
  passthrough: {
    keyLabel: 'providerهای pass-through',
    keyHint:
      'شناسهٔ providerهایی (یا *) که این کلید می‌تواند از مسیر /passthrough/{provider}/… صدا بزند؛ خالی یعنی pass-through خاموش است. فقط مالک و مدیر سازمان می‌توانند این مجوز را بدهند.',
    paths: 'مسیرهای مجاز pass-through',
    pathsHint:
      'هر خط یک مسیر نسبت به Base URL، مثل «POST /batches» یا «/files/*» (ستاره یعنی هر ادامه‌ای). خالی یعنی هیچ مسیری مجاز نیست.',
  },
  balance: {
    amount: 'موجودی: {{amount}} {{currency}}',
    failed: 'استعلام ناموفق: {{error}}',
    checkedAt: 'به‌روزشده در {{date}}',
    refresh: 'به‌روزرسانی موجودی',
    refreshing: 'در حال استعلام…',
  },
} as const;

export const upstreamServicesEn: Widen<typeof upstreamServicesFa> = {
  passthrough: {
    keyLabel: 'Pass-through providers',
    keyHint:
      'Provider slugs (or *) this key may call through /passthrough/{provider}/…; empty keeps pass-through off. Only owners and admins can grant it.',
    paths: 'Pass-through allowed paths',
    pathsHint:
      'One path per line, relative to the base URL, such as "POST /batches" or "/files/*" (a trailing * matches anything after it). Empty allows no path.',
  },
  balance: {
    amount: 'Balance: {{amount}} {{currency}}',
    failed: 'Lookup failed: {{error}}',
    checkedAt: 'Checked {{date}}',
    refresh: 'Refresh balance',
    refreshing: 'Looking up…',
  },
};
