import { describe, expect, it } from 'vitest';

import { invoiceLegs, taxableUsd, taxSplit } from './invoices.js';
import { assertBalanced, LedgerError, SYSTEM_WALLETS, toUnits } from './ledger.js';
import { allocate, percentToBasisPoints, rialTotals, splitVat, usdToRials } from './tax.js';

describe('VAT split', () => {
  it('splits a VAT-inclusive amount into net and VAT that add up exactly', () => {
    expect(splitVat('110', '10')).toEqual({
      grossUsd: '110.00000000',
      netUsd: '100.00000000',
      vatUsd: '10.00000000',
    });
    // 6.375 × 10 / 110 = 0.57954545(45…) rounds half up to 0.57954545
    expect(splitVat('6.375', '10')).toEqual({
      grossUsd: '6.37500000',
      netUsd: '5.79545455',
      vatUsd: '0.57954545',
    });
    for (const [gross, percent] of [
      ['0.00000001', '10'],
      ['1234.56789', '9.5'],
      ['99.99999999', '12'],
      ['5', '0'],
    ] as const) {
      const s = splitVat(gross, percent);
      expect(toUnits(s.netUsd) + toUnits(s.vatUsd)).toBe(toUnits(s.grossUsd));
    }
    expect(splitVat('5', '0').vatUsd).toBe('0.00000000');
  });

  it('accepts rates to hundredths of a percent below 100', () => {
    expect(percentToBasisPoints('10')).toBe(1000n);
    expect(percentToBasisPoints('9.5')).toBe(950n);
    for (const bad of ['100', '-1', '10.123', 'ten', ''])
      expect(() => percentToBasisPoints(bad)).toThrow(LedgerError);
    expect(() => splitVat('-1', '10')).toThrow(LedgerError);
  });

  it('takes the taxable amount from usage and plan fees, or the postpaid amount due', () => {
    const prepaid = {
      basis: 'prepaid' as const,
      closingUsd: '17.625',
      totals: { topup: '20', gift: '5', plan: '-2', adjustment: '-1', usage: '-4.375' },
    };
    expect(taxableUsd(prepaid)).toBe('6.37500000');
    expect(taxableUsd({ basis: 'postpaid', closingUsd: '8', totals: { usage: '8' } })).toBe(
      '8.00000000',
    );
    expect(taxSplit('0.00000000', '10').vatUsd).toBe('0.00000000');
  });

  it('books balanced ledger legs with VAT on its own account', () => {
    const prepaid = invoiceLegs('prepaid', splitVat('110', '10'));
    expect(prepaid).toEqual([
      { walletId: SYSTEM_WALLETS.revenue, amountUsd: '-10.00000000' },
      { walletId: SYSTEM_WALLETS.vat, amountUsd: '10.00000000' },
    ]);
    const postpaid = invoiceLegs('postpaid', splitVat('110', '10'));
    expect(postpaid).toEqual([
      { walletId: SYSTEM_WALLETS.receivable, amountUsd: '-110.00000000' },
      { walletId: SYSTEM_WALLETS.revenue, amountUsd: '100.00000000' },
      { walletId: SYSTEM_WALLETS.vat, amountUsd: '10.00000000' },
    ]);
    expect(() => assertBalanced(prepaid)).not.toThrow();
    expect(() => assertBalanced(postpaid)).not.toThrow();
    // No VAT on a prepaid invoice means nothing to book; a postpaid sale is still booked.
    expect(invoiceLegs('prepaid', splitVat('5', '0'))).toEqual([]);
    expect(invoiceLegs('postpaid', splitVat('5', '0'))).toHaveLength(2);
  });
});

describe('allocation and rials', () => {
  it('shares a total in proportion without losing a unit', () => {
    expect(allocate(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    expect(allocate(100n, [50n, 25n, 25n])).toEqual([50n, 25n, 25n]);
    expect(allocate(7n, [0n, 0n])).toEqual([7n, 0n]);
    const shares = allocate(57954545n, [312500000n, 125000000n, 200000000n]);
    expect(shares.reduce((s, v) => s + v, 0n)).toBe(57954545n);
  });

  it('converts to whole rials, half up, and keeps the totals consistent', () => {
    expect(usdToRials('17.625', '1050000')).toBe(18_506_250n);
    expect(usdToRials('0.0000005', '1')).toBe(0n);
    expect(usdToRials('0.5', '1')).toBe(1n);
    expect(usdToRials('-0.5', '1')).toBe(-1n);
    const totals = rialTotals(splitVat('6.375', '10'), '1050000.5');
    expect(totals.netRials + totals.vatRials).toBe(totals.grossRials);
    expect(() => usdToRials('1', 'abc')).toThrow(LedgerError);
  });
});
