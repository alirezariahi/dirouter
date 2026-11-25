import { describe, expect, it } from 'vitest';

import { firstBackBudget } from './spend-guard.js';

const at = (name: string, hours: number) => ({ name, resetAt: new Date(hours * 3_600_000) });

describe('firstBackBudget (card 32.6)', () => {
  it('names the budget that keeps every target out the longest when they share it', () => {
    const daily = at('credential daily', 5);
    const monthly = at('provider monthly', 500);
    // seat-1 is blocked by its daily budget and the provider budget; seat-2 by the provider budget.
    expect(firstBackBudget([[daily, monthly], [monthly]], [daily, monthly])).toBe(monthly);
  });

  it('picks the target that comes back first', () => {
    const a = at('a daily', 5);
    const b = at('b weekly', 50);
    expect(firstBackBudget([[a], [b]], [a, b])).toBe(a);
  });

  it('falls back to the soonest reset when no target lists a budget', () => {
    const a = at('a', 9);
    const b = at('b', 3);
    expect(firstBackBudget([[], []], [a, b])).toBe(b);
  });
});
