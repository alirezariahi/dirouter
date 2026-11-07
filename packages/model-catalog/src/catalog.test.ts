import { describe, expect, it } from 'vitest';

import {
  catalog,
  computeCost,
  computeCostUsd,
  countTokens,
  estimateOutputTokens,
  estimateRequestTokens,
  estimateUsage,
  findByUpstream,
  findCatalogEntry,
  roughTokens,
} from './index.js';

const usage = (over: Partial<Parameters<typeof computeCostUsd>[0]> = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...over,
});

describe('catalog', () => {
  it('has unique keys and valid prices', () => {
    expect(new Set(catalog.models.map((m) => m.key)).size).toBe(catalog.models.length);
    expect(findCatalogEntry('openai/gpt-4.1')?.pricing.inputPerMTok).toBe('2.00');
    expect(findByUpstream('anthropic', 'claude-sonnet-4-5')?.key).toBe(
      'anthropic/claude-sonnet-4-5',
    );
  });
});

describe('cost with real prices', () => {
  it('GPT-4.1: 1200 in (1024 cached) + 300 out', () => {
    const pricing = findCatalogEntry('openai/gpt-4.1')!.pricing;
    // 176 × $2 + 1024 × $0.5 + 300 × $8, per 1M
    expect(
      computeCostUsd(
        usage({ inputTokens: 1200, cacheReadTokens: 1024, outputTokens: 300 }),
        pricing,
      ),
    ).toBe('0.00326400');
  });

  it('Claude Sonnet 4.5 with cache read and write', () => {
    const pricing = findCatalogEntry('anthropic/claude-sonnet-4-5')!.pricing;
    // input 472 × 3 + read 1024 × 0.3 + write 2000 × 3.75 + out 89 × 15
    const cost = computeCost(
      usage({ inputTokens: 3496, cacheReadTokens: 1024, cacheWriteTokens: 2000, outputTokens: 89 }),
      pricing,
    );
    expect(
      computeCostUsd(
        usage({
          inputTokens: 3496,
          cacheReadTokens: 1024,
          cacheWriteTokens: 2000,
          outputTokens: 89,
        }),
        pricing,
      ),
    ).toBe('0.01055820');
    expect(cost.cacheWrite).toBe(750_000n);
  });

  it('o3 reasoning tokens are priced as output', () => {
    const pricing = findCatalogEntry('openai/o3')!.pricing;
    expect(
      computeCostUsd(
        usage({ inputTokens: 100, outputTokens: 5000, reasoningTokens: 4000 }),
        pricing,
      ),
    ).toBe('0.04020000');
  });

  it('separate reasoning price when set', () => {
    expect(
      computeCostUsd(usage({ outputTokens: 10, reasoningTokens: 10 }), {
        inputPerMTok: '1',
        outputPerMTok: '2',
        reasoningPerMTok: '4',
      }),
    ).toBe('0.00004000');
  });

  it('a million tiny requests add up exactly', () => {
    const pricing = findCatalogEntry('openai/gpt-4.1-nano')!.pricing;
    let total = 0n;
    for (let i = 0; i < 1_000_000; i++)
      total += computeCost(usage({ inputTokens: 10 }), pricing).total;
    expect(total).toBe(100_000_000n); // 10M token × $0.10 = $1
    // runnerهای CI چند برابر کندترند؛ این تست عمداً سنگین است.
  }, 60_000);
});

describe('token estimation', () => {
  it('counts with o200k and roughly estimates', () => {
    expect(countTokens('hello world')).toBe(2);
    expect(countTokens('')).toBe(0);
    expect(roughTokens('abcdefgh')).toBe(2);
    expect(roughTokens('سلام')).toBe(2);
  });

  it('estimates a canonical request', () => {
    const n = estimateRequestTokens({
      inboundApi: 'openai.chat',
      model: 'x',
      stream: false,
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is the weather?' },
            { type: 'image', source: { kind: 'url', url: 'u' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c', name: 'w', arguments: '{"city":"Tehran"}' }],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolCallId: 'c', content: [{ type: 'text', text: '18C' }] },
          ],
        },
      ],
      tools: [{ name: 'w', parameters: { type: 'object' } }],
    });
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(140);
  });
});

describe('usage estimation without provider usage', () => {
  const req = {
    inboundApi: 'openai.chat' as const,
    model: 'x',
    stream: false,
    system: [],
    messages: [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello world' }] },
    ],
  };

  it('estimates output from response parts and from stream text alike', () => {
    const parts = [
      { type: 'text' as const, text: 'Hello from the DiRouter mock provider.' },
      { type: 'tool_call' as const, id: 'c', name: 'get_weather', arguments: '{"city":"Tehran"}' },
    ];
    expect(estimateOutputTokens([parts[0]!])).toBe(8);
    expect(estimateOutputTokens(parts)).toBeGreaterThan(8);
    const fromParts = estimateUsage(req, [parts[0]!]);
    const fromText = estimateUsage(req, 'Hello from the DiRouter mock provider.');
    expect(fromParts).toEqual(fromText);
    expect(fromParts).toEqual({
      inputTokens: 4 + 2,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });
});
