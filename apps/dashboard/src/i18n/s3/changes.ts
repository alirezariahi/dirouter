export const changesFa = {
  require: 'تغییرات حساس به تأیید نفر دوم نیاز دارند (اصل چهارچشمی)',
  requireHelp:
    'حذف provider، تغییر بودجهٔ کلیدها، تغییر نقش اعضا و خاموش کردن همین گزینه ثبت می‌شوند و پس از تأیید یک عضو دیگر خودکار اعمال می‌شوند.',
  title: 'درخواست‌های تغییر در انتظار تأیید',
  help: 'درخواست‌دهنده نمی‌تواند درخواست خودش را تأیید کند؛ فقط می‌تواند آن را لغو کند.',
  none: 'درخواستی در انتظار نیست.',
  requestedBy: 'درخواست از {{who}}',
  approve: 'تأیید و اعمال',
  reject: 'رد',
  cancel: 'لغو',
  queued: 'این تغییر به تأیید نفر دوم نیاز دارد و ثبت شد:',
  view: 'درخواست‌ها',
  dismiss: 'بستن',
} as const;

export const changesEn = {
  require: 'Sensitive changes need a second person’s approval (four-eyes)',
  requireHelp:
    'Deleting a provider, changing key budgets, changing member roles and turning this off are recorded and applied automatically once another member approves.',
  title: 'Change requests awaiting approval',
  help: 'A requester cannot approve their own request; they can only cancel it.',
  none: 'No pending requests.',
  requestedBy: 'Requested by {{who}}',
  approve: 'Approve and apply',
  reject: 'Reject',
  cancel: 'Cancel',
  queued: 'This change needs a second person’s approval and was recorded:',
  view: 'Requests',
  dismiss: 'Dismiss',
};
