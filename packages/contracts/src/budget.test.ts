import { describe, expect, it } from 'vitest';

import {
  budgetCounterKey,
  budgetPeriodKey,
  budgetPeriodRange,
  unitsToUsd,
  usdToUnits,
} from './budget.js';

describe('budget counters', () => {
  it('uses UTC day and month boundaries', () => {
    const at = new Date('2026-11-08T23:59:59.000Z');
    expect(budgetPeriodKey('daily', at)).toBe('d:2026-11-08');
    expect(budgetPeriodKey('monthly', at)).toBe('m:2026-11');
    expect(budgetPeriodRange('daily', at)).toEqual({
      start: new Date('2026-11-08T00:00:00.000Z'),
      end: new Date('2026-11-09T00:00:00.000Z'),
    });
    expect(budgetPeriodRange('monthly', at)).toEqual({
      start: new Date('2026-11-01T00:00:00.000Z'),
      end: new Date('2026-12-01T00:00:00.000Z'),
    });
    expect(budgetCounterKey('b', 'd:2026-11-08')).toBe('dirouter:budget:b:d:2026-11-08');
  });

  it('converts decimal dollars without floating-point ledger arithmetic', () => {
    expect(usdToUnits('0.00012345')).toBe(12_345);
    expect(usdToUnits('-2.5')).toBe(-250_000_000);
    expect(usdToUnits('.1')).toBe(10_000_000);
    expect(usdToUnits('invalid')).toBe(0);
    expect(unitsToUsd(12_345)).toBe('0.00012345');
  });
});
