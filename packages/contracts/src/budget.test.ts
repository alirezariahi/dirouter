import { describe, expect, it } from 'vitest';

import {
  budgetCounterKey,
  budgetPeriodKey,
  budgetPeriodLabel,
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

  it('weeks start on Monday 00:00 UTC and years on 1 January (card 33.1)', () => {
    // Sunday 29 November 2026 belongs to the week that started on Monday the 23rd.
    const sunday = new Date('2026-11-29T23:59:59.999Z');
    expect(budgetPeriodKey('weekly', sunday)).toBe('w:2026-11-23');
    expect(budgetPeriodRange('weekly', sunday)).toEqual({
      start: new Date('2026-11-23T00:00:00.000Z'),
      end: new Date('2026-11-30T00:00:00.000Z'),
    });
    const monday = new Date('2026-11-30T00:00:00.000Z');
    expect(budgetPeriodKey('weekly', monday)).toBe('w:2026-11-30');
    // A week across a year boundary keeps one key.
    expect(budgetPeriodKey('weekly', new Date('2027-01-01T12:00:00.000Z'))).toBe('w:2026-12-28');
    expect(budgetPeriodKey('yearly', sunday)).toBe('y:2026');
    expect(budgetPeriodRange('yearly', sunday)).toEqual({
      start: new Date('2026-01-01T00:00:00.000Z'),
      end: new Date('2027-01-01T00:00:00.000Z'),
    });
    expect(budgetPeriodLabel('weekly')).toBe('Weekly');
  });

  it('converts decimal dollars without floating-point ledger arithmetic', () => {
    expect(usdToUnits('0.00012345')).toBe(12_345);
    expect(usdToUnits('-2.5')).toBe(-250_000_000);
    expect(usdToUnits('.1')).toBe(10_000_000);
    expect(usdToUnits('invalid')).toBe(0);
    expect(unitsToUsd(12_345)).toBe('0.00012345');
  });
});
