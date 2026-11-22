import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

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
    const missing: string[] = [];
    for (const file of sources(join(__dirname, '..'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([\w.-]+)'/g)) {
        const key = match[1] ?? '';
        if (!(key in enFlat)) missing.push(`${file.split('/src/')[1] ?? file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
