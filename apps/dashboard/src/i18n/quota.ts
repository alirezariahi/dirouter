/** Quota windows of a credential and their countdown (card 32.6): Health and Providers pages. */
import type { Widen } from './s2/types';

export const quotaFa = {
  window: 'پنجرهٔ {{id}} ({{hours}} ساعت)',
  requests: '{{used}} از {{limit}} درخواست',
  tokens: '{{used}} از {{limit}} توکن',
  usd: '{{used}} از {{limit}} دلار',
  resetsIn: 'ریست تا {{time}}',
  notStarted: 'هنوز شروع نشده؛ با اولین درخواست شروع می‌شود',
  exhausted: 'تمام شده؛ تا ریست از چرخش بیرون است',
  spend: {
    title: 'بودجه، سهمیه و ترتیب credentialها',
    help: 'سقف خرج کل این provider و هر credential (برای همهٔ سازمان‌هایی که از آن استفاده می‌کنند) و پنجره‌های سهمیهٔ پلن‌های کدنویسی با API key. credentialی که به سقف برسد بدون خطا جایش را به بعدی می‌دهد. اشتراک‌های مصرف‌کننده با OAuth پشتیبانی نمی‌شوند.',
    strategy: 'ترتیب credentialها',
    strategies: {
      weighted: 'تصادفی وزن‌دار',
      'fill-first': 'اول پر کردن یکی (fill-first)',
      'reset-aware': 'اول آن‌که زودتر ریست می‌شود (reset-aware)',
    },
    providerBudget: 'بودجهٔ ماهانهٔ کل provider (دلار)',
    credentialBudget: 'بودجهٔ روزانهٔ «{{name}}» (دلار)',
    windows: 'پنجره‌های سهمیهٔ «{{name}}»',
    windowsHelp:
      'هر خط: شناسه، ساعت، سقف درخواست، سقف توکن، سقف دلار (خالی یعنی بدون سقف)؛ مثلاً 5h, 5, 200 یا week, 168, , , 100',
    save: 'ذخیرهٔ بودجه و سهمیه',
    saved: 'ذخیره شد.',
    queued: 'تغییر بودجه برای تأیید نفر دوم ثبت شد.',
    invalid: 'یک خط پنجره نامعتبر است: «{{line}}».',
  },
} as const;

export const quotaEn: Widen<typeof quotaFa> = {
  window: '{{id}} window ({{hours}} h)',
  requests: '{{used}} of {{limit}} requests',
  tokens: '{{used}} of {{limit}} tokens',
  usd: '{{used}} of {{limit}} USD',
  resetsIn: 'resets in {{time}}',
  notStarted: 'not started; the first request starts it',
  exhausted: 'used up; out of rotation until it resets',
  spend: {
    title: 'Budgets, quotas and credential order',
    help: 'Spend caps of this whole provider and of each credential (over every organization using it), and quota windows of coding plans used with an API key. A credential at its cap hands the traffic to the next one without an error. Consumer subscriptions signed in with OAuth are not supported.',
    strategy: 'Credential order',
    strategies: {
      weighted: 'Weighted random',
      'fill-first': 'Fill one first (fill-first)',
      'reset-aware': 'Soonest reset first (reset-aware)',
    },
    providerBudget: 'Monthly budget of the whole provider (USD)',
    credentialBudget: 'Daily budget of “{{name}}” (USD)',
    windows: 'Quota windows of “{{name}}”',
    windowsHelp:
      'One per line: id, hours, request cap, token cap, USD cap (blank means none); e.g. 5h, 5, 200 or week, 168, , , 100',
    save: 'Save budgets and quotas',
    saved: 'Saved.',
    queued: 'The budget change is waiting for a second person’s approval.',
    invalid: 'A window line is not valid: “{{line}}”.',
  },
};
