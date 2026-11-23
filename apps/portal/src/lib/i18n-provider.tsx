/** Language state (Persian right-to-left by default) for the whole portal. */
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { en, fa, I18nContext, type Lang, LANG_STORAGE } from './i18n';

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() =>
    localStorage.getItem(LANG_STORAGE) === 'en' ? 'en' : 'fa',
  );
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'fa' ? 'rtl' : 'ltr';
    localStorage.setItem(LANG_STORAGE, lang);
  }, [lang]);
  const value = useMemo(
    () => ({
      t: lang === 'fa' ? fa : en,
      lang,
      toggle: () => {
        setLang((l) => (l === 'fa' ? 'en' : 'fa'));
      },
    }),
    [lang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
