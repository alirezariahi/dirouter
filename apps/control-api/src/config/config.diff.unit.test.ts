/** Versioned config helpers (card 17.1): diff between two snapshots and import parsing. */
import { describe, expect, it } from 'vitest';

import { diff, parseConfigText } from './config.diff.js';

describe('diff', () => {
  it('reports nothing for equal values', () => {
    expect(diff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
  });

  it('reports changed, added and removed leaves with their path', () => {
    const changes = diff(
      { settings: { failMode: 'open' }, models: [{ slug: 'a' }], gone: 1 },
      { settings: { failMode: 'closed' }, models: [{ slug: 'a' }, { slug: 'b' }], added: true },
    );
    expect(changes).toContainEqual({ path: 'settings.failMode', before: 'open', after: 'closed' });
    expect(changes).toContainEqual({ path: 'models.1', before: undefined, after: { slug: 'b' } });
    expect(changes).toContainEqual({ path: 'gone', before: 1, after: undefined });
    expect(changes).toContainEqual({ path: 'added', before: undefined, after: true });
    expect(changes).toHaveLength(4);
  });

  it('treats a type change as one replacement', () => {
    expect(diff({ a: [1] }, { a: { 0: 1 } })).toEqual([
      { path: 'a', before: [1], after: { 0: 1 } },
    ]);
    expect(diff(1, 2)).toEqual([{ path: '(root)', before: 1, after: 2 }]);
  });
});

describe('parseConfigText', () => {
  it('parses an export produced by this service', () => {
    expect(parseConfigText('{"schemaVersion":1}')).toEqual({ schemaVersion: 1 });
  });

  it('rejects anything else with a 400 and no side effect', () => {
    expect(() => parseConfigText('schemaVersion: 1\nproviders: []')).toThrow();
    expect(() => parseConfigText('')).toThrow();
  });
});
