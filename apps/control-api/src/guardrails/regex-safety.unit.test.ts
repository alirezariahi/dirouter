/** Static regex safety check for guardrail policies (cards 15.1 and 15.2). */
import { describe, expect, it } from 'vitest';

import { assertSafeRegexPolicy, previewGuardrail } from './guardrails.service.js';
import { MAX_PATTERN_LENGTH, unsafeRegexReason } from './regex-safety.js';

describe('unsafeRegexReason', () => {
  it('refuses catastrophic shapes', () => {
    for (const pattern of [
      '(a+)+$',
      '(a*)*',
      '(?:a+)*b',
      '(.+){2,}',
      '(\\d+)+x',
      '((a+)b)+',
      '(a{2,})+',
      '([a-z]+)*$',
      '(a|a)+$',
      '(a|ab)*c',
      '(\\w|\\d)+$',
      '(a|)+',
      '(.|a)*',
      '(a)\\1',
      '(?<n>a)\\k<n>',
    ])
      expect(unsafeRegexReason(pattern), pattern).toBeTypeOf('string');
  });

  it('accepts ordinary patterns', () => {
    for (const pattern of [
      'secret-\\d{4}',
      '\\b\\d{10}\\b',
      '\\b(?:\\d[ -]?){13,19}\\b',
      '(foo|bar)+',
      '(?:https?://)[\\w.-]+',
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
      'a\\+\\(b\\)\\*',
      '[(+*]+x',
      '(?<year>\\d{4})-(?<month>\\d{2})',
    ])
      expect(unsafeRegexReason(pattern), pattern).toBeUndefined();
  });

  it('refuses invalid, empty or oversized patterns and unknown flags', () => {
    expect(unsafeRegexReason('(')).toBe('invalid regex pattern');
    expect(unsafeRegexReason('')).toBe('pattern is empty');
    expect(unsafeRegexReason('a'.repeat(MAX_PATTERN_LENGTH + 1))).toContain('longer than');
    expect(unsafeRegexReason('a', 'x')).toBe('invalid regex flags');
  });
});

describe('regex policies', () => {
  it('are checked when saved and when previewed', () => {
    expect(() => {
      assertSafeRegexPolicy('regex', { pattern: '(a+)+$' });
    }).toThrow(/unsafe regex/);
    expect(() => {
      assertSafeRegexPolicy('regex', {});
    }).toThrow(/config.pattern/);
    expect(() => {
      assertSafeRegexPolicy('keyword', { pattern: '(a+)+$' });
    }).not.toThrow();
    expect(() =>
      previewGuardrail({ name: 'p', type: 'regex', config: { pattern: '(a+)+$' } }, 'aaaa!'),
    ).toThrow(/unsafe regex/);
  });

  it('still previews a safe pattern, with or without the global flag', () => {
    const input = { name: 'p', type: 'regex', action: 'redact' as const };
    const result = previewGuardrail(
      { ...input, config: { pattern: 'secret-\\d{4}' } },
      'a secret-1234 and secret-9999',
    );
    expect(result.matches).toEqual(['secret-1234', 'secret-9999']);
    expect(
      previewGuardrail({ ...input, config: { pattern: 'SECRET', flags: 'i' } }, 'a secret').matches,
    ).toEqual(['secret']);
  });

  it('stops a slow pattern that the static check does not catch', () => {
    // Polynomial, not exponential: accepted statically, cut off by the preview time limit.
    const pattern = '.*.*.*.*.*.*.*=';
    expect(unsafeRegexReason(pattern, 'gs')).toBeUndefined();
    const started = Date.now();
    expect(() =>
      previewGuardrail(
        { name: 'p', type: 'regex', config: { pattern, flags: 'gs' } },
        'a'.repeat(10_000),
      ),
    ).toThrow(/too slow/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
