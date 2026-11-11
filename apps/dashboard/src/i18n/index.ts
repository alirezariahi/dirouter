/** i18n (card 7.1): Persian by default and English; changing the language also changes the page direction. */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { applyLang, type Lang, prefs } from '../lib/prefs';
import { en } from './en';
import { fa } from './fa';

export function setupI18n(lang: Lang = prefs.lang()) {
  void i18n.use(initReactI18next).init({
    resources: { fa: { translation: fa }, en: { translation: en } },
    lng: lang,
    fallbackLng: 'fa',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  applyLang(lang);
  i18n.on('languageChanged', (lng) => {
    const next: Lang = lng === 'en' ? 'en' : 'fa';
    applyLang(next);
    prefs.setLang(next);
  });
  return i18n;
}

export { i18n };
