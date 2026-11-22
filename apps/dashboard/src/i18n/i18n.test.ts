import { describe, expect, it } from 'vitest';

import { prefs } from '../lib/prefs';
import { en } from './en';
import { fa } from './fa';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = '', out: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

const persian = /[؀-ۿ]/;
const enFlat = flatten(en);
const faFlat = flatten(fa);
// The language switch shows the other language's own name.
const nativeNames = new Set(['palette.toggleLanguage']);

// Page and component sources as text, outside the message modules and tests.
const sources = Object.entries(
  import.meta.glob<string>(['../**/*.{ts,tsx}', '!../i18n/**', '!../**/*.test.*'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
);

describe('locale messages', () => {
  it('defaults to English and the Gregorian calendar', () => {
    localStorage.clear();
    expect(prefs.lang()).toBe('en');
    expect(prefs.calendar()).toBe('gregory');
  });

  it('has the same keys in both languages', () => {
    expect(Object.keys(faFlat).sort()).toEqual(Object.keys(enFlat).sort());
  });

  it('keeps Persian text out of the English messages', () => {
    const mixed = Object.entries(enFlat).filter(
      ([key, value]) => !nativeNames.has(key) && persian.test(value),
    );
    expect(mixed).toEqual([]);
  });

  it('defines every literal key the pages ask for', () => {
    expect(sources.length).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const [file, text] of sources) {
      for (const match of text.matchAll(/\bt\(\s*'([\w.-]+)'/g)) {
        const key = match[1] ?? '';
        if (!(key in enFlat)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
