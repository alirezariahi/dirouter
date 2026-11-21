/** Playground cost estimate and request validation (card 16.5). */
import { describe, expect, it } from 'vitest';

import { estimateCostUsd, PlaygroundBody } from './playground.schema.js';

describe('estimateCostUsd', () => {
  it('uses per-million-token prices', () => {
    expect(estimateCostUsd(1_000_000, 0, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(
      '3.00000000',
    );
    expect(estimateCostUsd(1_000, 2_000, { inputPerMTok: 3, outputPerMTok: 15 })).toBe(
      '0.03300000',
    );
    expect(estimateCostUsd(0, 0, { inputPerMTok: 3, outputPerMTok: 15 })).toBe('0.00000000');
  });
});

describe('PlaygroundBody', () => {
  const base = { apiKey: 'dr-abcdefgh-secretsecret', models: ['a', 'b'], prompt: 'hi' };

  it('applies defaults and accepts up to four distinct models', () => {
    expect(PlaygroundBody.parse(base).maxTokens).toBe(512);
    expect(PlaygroundBody.safeParse({ ...base, models: ['a', 'b', 'c', 'd'] }).success).toBe(true);
  });

  it('rejects duplicates, too many models and oversized output', () => {
    expect(PlaygroundBody.safeParse({ ...base, models: ['a', 'a'] }).success).toBe(false);
    expect(PlaygroundBody.safeParse({ ...base, models: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(
      false,
    );
    expect(PlaygroundBody.safeParse({ ...base, models: [] }).success).toBe(false);
    expect(PlaygroundBody.safeParse({ ...base, maxTokens: 100_000 }).success).toBe(false);
  });
});
