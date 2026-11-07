import type { Messages } from './fa';

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };

export const en: Widen<Messages> = {
  app: { name: 'DiRouter', tagline: 'Smart gateway for language models' },
  nav: {
    overview: 'Overview',
    providers: 'Providers',
    keys: 'Virtual keys',
    models: 'Models & combos',
    logs: 'Request logs',
    health: 'Health',
    organization: 'Organization',
    guides: 'Connect your tools',
  },
  topbar: {
    search: 'Search or run a command…',
    language: 'Language',
    theme: 'Theme',
    calendar: 'Calendar',
    light: 'Light',
    dark: 'Dark',
    system: 'System',
    persian: 'Persian',
    gregory: 'Gregorian',
  },
  palette: {
    placeholder: 'Where to?',
    empty: 'No results',
    navigate: 'Go to',
    actions: 'Actions',
    toggleTheme: 'Toggle theme',
    toggleLanguage: 'فارسی',
  },
  state: {
    loading: 'Loading…',
    empty: 'Nothing here yet',
    error: 'Something went wrong',
    retry: 'Try again',
    soon: 'This section is coming soon.',
    notFound: 'Page not found',
    back: 'Back to overview',
  },
  overview: { title: 'Overview', today: 'Today is {{date}}' },
};
