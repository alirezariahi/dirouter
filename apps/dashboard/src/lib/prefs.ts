/**
 * ترجیحات کاربر (زبان، تم، تقویم) در localStorage، با try/catch چون ممکن است در دسترس نباشد.
 * اعمال روی <html>: lang و dir (rtl برای فارسی) و کلاس dark.
 */
import type { Calendar } from './date';

export type Lang = 'fa' | 'en';
export type Theme = 'light' | 'dark' | 'system';

const read = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(`dirouter.${key}`) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(`dirouter.${key}`, value);
  } catch {
    // ترجیح فقط برای همین نشست می‌ماند.
  }
};

export const prefs = {
  lang: () => read<Lang>('lang', ['fa', 'en'], 'fa'),
  theme: () => read<Theme>('theme', ['light', 'dark', 'system'], 'system'),
  calendar: () => read<Calendar>('calendar', ['persian', 'gregory'], 'persian'),
  setLang: (v: Lang) => {
    write('lang', v);
  },
  setTheme: (v: Theme) => {
    write('theme', v);
  },
  setCalendar: (v: Calendar) => {
    write('calendar', v);
  },
};

export function applyLang(lang: Lang, root: HTMLElement = document.documentElement) {
  root.lang = lang;
  root.dir = lang === 'fa' ? 'rtl' : 'ltr';
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}
