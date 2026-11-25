/** Media prices (card 21.1) on top of token prices. */
import { formatUsd, parseUsd } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import { audioTokenCost, batchPrice, computeCost, computeCostUsd, mediaCost } from './cost.js';

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

describe('video price (card 30.6)', () => {
  it('prices generated seconds and a fixed price per request', () => {
    const pricing = {
      inputPerMTok: '0',
      outputPerMTok: '0',
      perSecondUsd: '0.1',
      perRequestUsd: '0.05',
    };
    expect(computeCostUsd(none, pricing, { seconds: 8, requests: 1 })).toBe('0.85000000');
    expect(computeCostUsd(none, { inputPerMTok: '0', outputPerMTok: '0' }, { requests: 3 })).toBe(
      '0.00000000',
    );
  });
});

describe('realtime audio token cost (card 30.5)', () => {
  const pricing = {
    inputPerMTok: '4',
    outputPerMTok: '16',
    cacheReadPerMTok: '0.4',
    audioInputPerMTok: '32',
    audioOutputPerMTok: '64',
  };

  it('prices audio at the audio rates, cached audio at the cache read rate', () => {
    const media = { audioInputTokens: 1_000, audioCachedTokens: 200, audioOutputTokens: 500 };
    // 800 × $32/M + 200 × $0.4/M + 500 × $64/M
    expect(audioTokenCost(media, pricing)).toBe(5_768_000n);
    // Text tokens are priced as before and the audio share is added on top.
    const usage = { ...none, inputTokens: 100, outputTokens: 50 };
    expect(computeCostUsd(usage, pricing, media)).toBe('0.05888000');
  });

  it('falls back to the text rates when the model has no audio prices', () => {
    expect(
      audioTokenCost(
        { audioInputTokens: 1_000_000, audioOutputTokens: 1_000_000 },
        { inputPerMTok: '1', outputPerMTok: '2' },
      ),
    ).toBe(300_000_000n);
    expect(audioTokenCost(undefined, pricing)).toBe(0n);
  });
});

describe('batch price (card 30.1)', () => {
  it('takes the catalog discount off and rounds half up', () => {
    expect(formatUsd(batchPrice(parseUsd('1'), { batchDiscount: '0.5' }))).toBe('0.50000000');
    expect(formatUsd(batchPrice(parseUsd('0.00000003'), { batchDiscount: '0.5' }))).toBe(
      '0.00000002',
    );
    expect(formatUsd(batchPrice(parseUsd('2'), { batchDiscount: '1' }))).toBe('0.00000000');
  });

  it('is the normal price without a discount', () => {
    expect(batchPrice(parseUsd('1.5'), {})).toBe(parseUsd('1.5'));
  });
});
