import { describe, expect, it } from 'vitest';

import { chargeUsd } from './pricing.js';

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});
// 1M in + 1M out at $2 + $4 per million = $6 cost.
const pricing = { inputPerMTok: '2', outputPerMTok: '4' };
const million = usage(1_000_000, 1_000_000);

describe('sale price', () => {
  it('equals the cost without sale settings', () => {
    expect(chargeUsd(million, { pricing })).toBe('6.00000000');
  });

  it('applies the model multiplier and then the customer group multiplier', () => {
    const model = { pricing, sale: { multiplier: '1.25', cacheMultiplier: '0' } };
    expect(chargeUsd(million, model)).toBe('7.50000000');
    expect(chargeUsd(million, model, { groupMultiplier: '0.8' })).toBe('6.00000000');
  });

  it('a fixed per-request price ignores tokens and the model multiplier, not the group', () => {
    const model = {
      pricing,
      sale: { multiplier: '3', perRequestUsd: '0.04', cacheMultiplier: '0' },
    };
    expect(chargeUsd(usage(1, 1), model)).toBe('0.04000000');
    expect(chargeUsd(million, model, { groupMultiplier: '2' })).toBe('0.08000000');
  });

  it('a cached answer is sold at the cache multiplier (free by default)', () => {
    expect(chargeUsd(million, { pricing }, { cacheHit: true })).toBe('0.00000000');
    const model = { pricing, sale: { multiplier: '1', cacheMultiplier: '0.5' } };
    expect(chargeUsd(million, model, { cacheHit: true })).toBe('3.00000000');
  });

  it('rounds half up at the eighth decimal', () => {
    // 1 token × $1/M = $0.000001 × 1.5 = 0.0000015
    const model = {
      pricing: { inputPerMTok: '1', outputPerMTok: '1' },
      sale: { multiplier: '1.5', cacheMultiplier: '0' },
    };
    expect(chargeUsd(usage(1, 0), model)).toBe('0.00000150');
  });
});
