/** تنظیمات نمایش (تم و تقویم) با context؛ زبان را i18next نگه می‌دارد. */
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Calendar } from './lib/date';
import { applyTheme, type Lang, prefs, type Theme } from './lib/prefs';

interface Settings {
  lang: Lang;
  theme: Theme;
  calendar: Calendar;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
  setCalendar: (c: Calendar) => void;
}

const Ctx = createContext<Settings | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const [theme, setThemeState] = useState<Theme>(prefs.theme());
  const [calendar, setCalendarState] = useState<Calendar>(prefs.calendar());
  const lang: Lang = i18n.language === 'en' ? 'en' : 'fa';

  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => {
      applyTheme('system');
    };
    mq.addEventListener('change', on);
    return () => {
      mq.removeEventListener('change', on);
    };
  }, [theme]);

  const value = useMemo<Settings>(
    () => ({
      lang,
      theme,
      calendar,
      setLang: (l) => void i18n.changeLanguage(l),
      setTheme: (t) => {
        prefs.setTheme(t);
        setThemeState(t);
      },
      setCalendar: (c) => {
        prefs.setCalendar(c);
        setCalendarState(c);
      },
    }),
    [lang, theme, calendar, i18n],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): Settings {
  const s = useContext(Ctx);
  if (!s) throw new Error('SettingsProvider missing');
  return s;
}
