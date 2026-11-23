/** Media prices (card 21.1) on top of token prices. */
import { describe, expect, it } from 'vitest';

import { computeCost, computeCostUsd, mediaCost } from './cost.js';

const none = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

describe('media cost', () => {
  const pricing = {
    inputPerMTok: '5',
    outputPerMTok: '40',
    perImageUsd: '0.04',
    perMCharUsd: '15',
    perSecondUsd: '0.0001',
  };

  it('prices images, characters and seconds (to the millisecond)', () => {
    expect(computeCostUsd(none, pricing, { images: 3 })).toBe('0.12000000');
    expect(computeCostUsd(none, pricing, { characters: 1_000 })).toBe('0.01500000');
    expect(computeCostUsd(none, pricing, { seconds: 61.2345 })).toBe('0.00612350');
  });

  it('adds media to token cost and ignores units without a price', () => {
    const breakdown = computeCost({ ...none, outputTokens: 1_000_000 }, pricing, { images: 1 });
    expect(breakdown.media).toBe(4_000_000n);
    expect(breakdown.total).toBe(4_004_000_000n);
    expect(mediaCost({ images: 5 }, { inputPerMTok: '1', outputPerMTok: '1' })).toBe(0n);
    expect(mediaCost(undefined, pricing)).toBe(0n);
  });
});
