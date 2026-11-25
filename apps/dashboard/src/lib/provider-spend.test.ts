import { describe, expect, it } from 'vitest';

import { amountOf, countdown, parseWindows, windowsText, withAmount } from './provider-spend';

describe('provider spend form (card 32.6)', () => {
  const budgets = [
    {
      id: 'b1',
      period: 'monthly' as const,
      limitUsd: '500',
      limitTokens: null,
      alertThresholds: [50, 80, 100],
    },
    {
      id: 'b2',
      period: 'weekly' as const,
      limitUsd: null,
      limitTokens: 1000,
      alertThresholds: [80],
    },
  ];

  it('edits one period and keeps the budgets of the others', () => {
    expect(amountOf(budgets, 'monthly')).toBe('500');
    expect(amountOf(budgets, 'daily')).toBe('');
    expect(withAmount(budgets, 'monthly', '250')).toEqual([
      { period: 'weekly', limitTokens: 1000, alertThresholds: [80] },
      { period: 'monthly', limitUsd: '250' },
    ]);
    expect(withAmount(budgets, 'monthly', ' ')).toEqual([
      { period: 'weekly', limitTokens: 1000, alertThresholds: [80] },
    ]);
    expect(withAmount(budgets, 'monthly', 'abc')).toBe('invalid');
    expect(withAmount(budgets, 'monthly', '0')).toBe('invalid');
  });

  it('reads and writes quota window lines with request, token and USD caps', () => {
    const windows = [
      { id: '5h', hours: 5, limitRequests: 200 },
      { id: 'week', hours: 168, limitUsd: '100' },
      { id: 'tok', hours: 24, limitRequests: 10, limitTokens: 5000 },
    ];
    const text = windowsText(windows);
    expect(text).toBe('5h, 5, 200\nweek, 168, , , 100\ntok, 24, 10, 5000');
    expect(parseWindows(text)).toEqual(windows);
    expect(parseWindows('')).toEqual([]);
    expect(parseWindows('5h, 5')).toEqual({ invalid: '5h, 5' });
    expect(parseWindows('Bad, 5, 1')).toEqual({ invalid: 'Bad, 5, 1' });
    expect(parseWindows('x, 745, 1')).toEqual({ invalid: 'x, 745, 1' });
    expect(parseWindows('x, 5, 1.5')).toEqual({ invalid: 'x, 5, 1.5' });
  });

  it('counts down to the reset of a window', () => {
    const now = Date.parse('2026-11-25T10:00:00Z');
    expect(countdown('2026-11-25T15:00:00Z', now)).toBe('5:00:00');
    expect(countdown('2026-11-25T10:01:05Z', now)).toBe('0:01:05');
    expect(countdown('2026-12-02T11:30:00Z', now)).toBe('7d 1:30:00');
    expect(countdown('2026-11-25T09:00:00Z', now)).toBe('0:00:00');
  });
});
