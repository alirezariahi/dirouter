import { describe, expect, it } from 'vitest';

import { assertBalanced, fromUnits, LedgerError, toUnits } from './ledger.js';

describe('ledger money', () => {
  it('round-trips amounts at 8 decimals', () => {
    for (const v of ['0', '1', '-1', '0.00000001', '12.5', '-0.3', '9999999999.99999999'])
      expect(toUnits(fromUnits(toUnits(v)))).toBe(toUnits(v));
    expect(fromUnits(toUnits('12.5'))).toBe('12.50000000');
    expect(fromUnits(-1n)).toBe('-0.00000001');
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const v of ['', '1e3', '0.123456789', 'NaN', '1,000', '--1'])
      expect(() => toUnits(v)).toThrow(LedgerError);
  });
});

describe('double-entry invariant', () => {
  it('accepts balanced legs', () => {
    expect(
      assertBalanced([
        { walletId: 'a', amountUsd: '10' },
        { walletId: 'b', amountUsd: '-7.5' },
        { walletId: 'c', amountUsd: '-2.5' },
      ]),
    ).toEqual([toUnits('10'), toUnits('-7.5'), toUnits('-2.5')]);
  });

  it.each([
    ['one leg', [{ walletId: 'a', amountUsd: '1' }], 'unbalanced'],
    [
      'a non-zero sum',
      [
        { walletId: 'a', amountUsd: '1' },
        { walletId: 'b', amountUsd: '-0.99999999' },
      ],
      'unbalanced',
    ],
    [
      'a zero leg',
      [
        { walletId: 'a', amountUsd: '0' },
        { walletId: 'b', amountUsd: '0' },
      ],
      'invalid_amount',
    ],
  ])('refuses %s', (_name, legs, code) => {
    expect(() => assertBalanced(legs)).toThrow(expect.objectContaining({ code }));
  });

  it('random balanced journals always sum to zero (property)', () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    let total = 0n;
    for (let t = 0; t < 500; t++) {
      const legs = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, i) => ({
        walletId: `w${String(i)}`,
        amountUsd: fromUnits(BigInt(1 + Math.floor(rand() * 1e10)) * (rand() < 0.5 ? -1n : 1n)),
      }));
      const rest = -legs.reduce((s, l) => s + toUnits(l.amountUsd), 0n);
      if (rest === 0n) continue;
      legs.push({ walletId: 'counter', amountUsd: fromUnits(rest) });
      total += assertBalanced(legs).reduce((s, u) => s + u, 0n);
    }
    expect(total).toBe(0n);
  });
});
