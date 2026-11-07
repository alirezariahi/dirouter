export const fa = {
  app: { name: 'دی‌روتر', tagline: 'درگاه هوشمند مدل‌های زبانی' },
  nav: {
    overview: 'نمای کلی',
    providers: 'Providerها',
    keys: 'کلیدهای مجازی',
    models: 'مدل‌ها و Combo',
    logs: 'لاگ درخواست‌ها',
    health: 'سلامت',
    organization: 'سازمان',
    guides: 'راهنمای اتصال',
  },
  topbar: {
    search: 'جستجو یا دستور…',
    language: 'زبان',
    theme: 'تم',
    calendar: 'تقویم',
    light: 'روشن',
    dark: 'تیره',
    system: 'سیستم',
    persian: 'شمسی',
    gregory: 'میلادی',
  },
  palette: {
    placeholder: 'به کجا برویم؟',
    empty: 'نتیجه‌ای پیدا نشد',
    navigate: 'رفتن به',
    actions: 'کارها',
    toggleTheme: 'تغییر تم',
    toggleLanguage: 'English',
  },
  state: {
    loading: 'در حال بارگذاری…',
    empty: 'هنوز چیزی اینجا نیست',
    error: 'خطایی رخ داد',
    retry: 'تلاش دوباره',
    soon: 'این بخش به‌زودی اضافه می‌شود.',
    notFound: 'صفحه پیدا نشد',
    back: 'بازگشت به نمای کلی',
  },
  overview: { title: 'نمای کلی', today: 'امروز {{date}}' },
} as const;

export type Messages = typeof fa;
