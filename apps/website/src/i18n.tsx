import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { english } from './translations.js';

type Locale = 'fa' | 'en';
type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (text: string) => string;
};
const LocaleContext = createContext<LocaleContextValue | null>(null);

function initialLocale(): Locale {
  const query = new URLSearchParams(window.location.search).get('lang');
  if (query === 'fa' || query === 'en') return query;
  try {
    return localStorage.getItem('dirouter-language') === 'en' ? 'en' : 'fa';
  } catch {
    return 'fa';
  }
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>(initialLocale);
  const value = useMemo(
    () => ({
      locale,
      setLocale: (next: Locale) => {
        updateLocale(next);
        const url = new URL(window.location.href);
        url.searchParams.set('lang', next);
        window.history.replaceState(null, '', url);
        try {
          localStorage.setItem('dirouter-language', next);
        } catch {
          /* Storage can be unavailable. */
        }
      },
      t: (text: string) => (locale === 'en' ? (english[text] ?? text) : text),
    }),
    [locale],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'fa' ? 'rtl' : 'ltr';
    document.title =
      locale === 'fa'
        ? 'DiRouter — یک مدار هوشمند برای مدل‌های شما'
        : 'DiRouter — Every model. One intelligent orbit.';
    const description =
      locale === 'fa'
        ? 'یک درگاه هوشمند برای اتصال مدل‌ها، مسیریابی درخواست‌ها و کنترل مصرف.'
        : 'An intelligent gateway for connecting models, routing requests, and controlling usage.';
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', document.title);
  }, [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('useLocale must be used within LocaleProvider');
  return value;
}
