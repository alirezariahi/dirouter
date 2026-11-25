/** Card 27.5: parsing, validation and diffing of external price sources (no network). */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { type CatalogEntry, catalog, findCatalogEntry } from './catalog.js';
import { computeCostUsd, effectivePricing } from './cost.js';
import {
  diffCatalog,
  mergeSources,
  normalizePricing,
  parseCatalogSource,
  samePricing,
  scaleDecimal,
  shrinkError,
} from './sync.js';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('./__fixtures__/litellm-sample.json', import.meta.url), 'utf8'),
);

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

describe('scaleDecimal', () => {
  it('turns per-token floats into exact per-million decimals', () => {
    expect(scaleDecimal(2e-6, 6)).toBe('2');
    expect(scaleDecimal(1.25e-6, 6)).toBe('1.25');
    expect(scaleDecimal(5.9e-7, 6)).toBe('0.59');
    expect(scaleDecimal(2e-8, 6)).toBe('0.02');
    expect(scaleDecimal(3e-15, 6)).toBe('0');
    expect(scaleDecimal(1.23456789e-6, 6)).toBe('1.23456789');
    expect(scaleDecimal(1.234567895e-6, 6)).toBe('1.2345679');
    expect(scaleDecimal('0.000003', 6)).toBe('3');
    expect(scaleDecimal(0.04, 0)).toBe('0.04');
    expect(scaleDecimal(0, 6)).toBe('0');
  });

  it('rejects negative, non-numeric and absurd values', () => {
    expect(scaleDecimal(-1, 6)).toBeUndefined();
    expect(scaleDecimal('abc', 6)).toBeUndefined();
    expect(scaleDecimal(Number.NaN, 6)).toBeUndefined();
    expect(scaleDecimal(1, 6)).toBeUndefined(); // $1 per token = $1M per million
  });
});

describe('parseCatalogSource (LiteLLM format)', () => {
  const parsed = parseCatalogSource(fixture);
  const by = (key: string) => parsed.entries.find((e) => e.key === key);

  it('maps providers, strips key prefixes and converts prices', () => {
    expect(parsed.format).toBe('litellm');
    expect(by('openai/gpt-4.1')).toMatchObject({
      provider: 'openai',
      upstreamModel: 'gpt-4.1',
      contextWindow: 1047576,
      maxOutputTokens: 32768,
      pricing: {
        inputPerMTok: '2',
        outputPerMTok: '8',
        cacheReadPerMTok: '0.5',
        batchDiscount: '0.5',
      },
      capabilities: { tools: true, vision: true, jsonMode: true, embeddings: false },
    });
    expect(by('gemini/gemini-2.5-pro')?.upstreamModel).toBe('gemini-2.5-pro');
    expect(by('groq/llama-3.3-70b-versatile')?.pricing).toEqual({
      inputPerMTok: '0.59',
      outputPerMTok: '0.79',
    });
  });

  it('reads context tiers, deprecation dates, embeddings and image prices', () => {
    expect(by('gemini/gemini-2.5-pro')?.pricing.tiers).toEqual([
      { aboveInputTokens: 200_000, inputPerMTok: '2.5', outputPerMTok: '15' },
    ]);
    expect(by('openai/gpt-4o')?.deprecationDate).toBe('2027-03-31');
    expect(by('openai/text-embedding-3-small')).toMatchObject({
      pricing: { inputPerMTok: '0.02', outputPerMTok: '0' },
      capabilities: { embeddings: true, streaming: false },
    });
    expect(by('openai/dall-e-3')?.pricing.perImageUsd).toBe('0.04');
  });

  it('skips unsupported providers and modes, broken prices and the sample spec', () => {
    const reasons = Object.fromEntries(parsed.skipped.map((s) => [s.key, s.reason]));
    expect(reasons['azure/gpt-4o']).toMatch(/provider azure not supported/);
    expect(reasons['openai/broken-price']).toMatch(/price/);
    expect(reasons['moderation-only']).toMatch(/mode moderation/);
    expect(parsed.entries.some((e) => e.key.includes('sample_spec'))).toBe(false);
  });

  it('rejects a document without any valid entry', () => {
    expect(() => parseCatalogSource({})).toThrow(/no valid model entries/);
    expect(() => parseCatalogSource([])).toThrow(/not a JSON object/);
    expect(() =>
      parseCatalogSource({ x: { litellm_provider: 'openai', input_cost_per_token: 'free' } }),
    ).toThrow(/no valid model entries/);
  });
});

describe('parseCatalogSource (DiRouter mirror format)', () => {
  it('accepts the bundled catalog itself, entry by entry', () => {
    const parsed = parseCatalogSource({
      models: [...catalog.models, { key: 'bad' }],
    });
    expect(parsed.format).toBe('dirouter');
    expect(parsed.entries).toHaveLength(catalog.models.length);
    expect(parsed.skipped).toEqual([{ key: 'bad', reason: 'invalid entry' }]);
  });
});

describe('mergeSources and diffCatalog', () => {
  const incoming = parseCatalogSource(fixture).entries;

  it('lets the first source win for the same key', () => {
    const mirror = parseCatalogSource({
      models: [
        {
          ...findCatalogEntry('openai/gpt-4.1')!,
          pricing: { inputPerMTok: '9', outputPerMTok: '9' },
        },
      ],
    });
    const merged = mergeSources([mirror, parseCatalogSource(fixture)]);
    expect(merged.find((e) => e.key === 'openai/gpt-4.1')?.pricing.inputPerMTok).toBe('9');
  });

  it('separates new models, price changes and metadata-only changes', () => {
    const diff = diffCatalog(catalog.models, incoming);
    expect(diff.added.map((e) => e.key)).toContain('openai/gpt-5.5-preview');
    // gpt-4o went from 2.50/10 to 3/12: a price change with its factor.
    const gpt4o = diff.priceChanged.find((c) => c.key === 'openai/gpt-4o');
    expect(gpt4o?.before.pricing.inputPerMTok).toBe('2.50');
    expect(gpt4o?.after.pricing.inputPerMTok).toBe('3');
    expect(gpt4o?.factor).toBeCloseTo(1.2);
    // groq llama has the same price in both (0.59/0.79): not a price change.
    expect(diff.priceChanged.some((c) => c.key === 'groq/llama-3.3-70b-versatile')).toBe(false);
  });

  it('treats 2.50 and 2.5 as the same price', () => {
    expect(
      samePricing(
        { inputPerMTok: '2.50', outputPerMTok: '10.00' },
        { inputPerMTok: '2.5', outputPerMTok: '10' },
      ),
    ).toBe(true);
    expect(normalizePricing({ inputPerMTok: '0.10', outputPerMTok: '000.40' })).toEqual({
      inputPerMTok: '0.1',
      outputPerMTok: '0.4',
    });
  });

  it('reports removals only for keys an earlier sync stored, and guards against truncation', () => {
    const current: CatalogEntry[] = [
      ...catalog.models,
      { ...findCatalogEntry('openai/gpt-4o')!, key: 'openai/gone', upstreamModel: 'gone' },
    ];
    const diff = diffCatalog(current, incoming, new Set(['openai/gone']));
    expect(diff.removed).toEqual(['openai/gone']);
    expect(shrinkError(100, 10)).toBeUndefined();
    expect(shrinkError(100, 60)).toMatch(/refusing a truncated catalog/);
    expect(shrinkError(5, 5)).toBeUndefined();
  });

  it('flags a rate that dropped to zero as an unbounded change', () => {
    const before = findCatalogEntry('openai/gpt-4.1')!;
    const diff = diffCatalog(
      [before],
      [{ ...before, pricing: { inputPerMTok: '0', outputPerMTok: '8' } }],
    );
    expect(diff.priceChanged[0]?.factor).toBe(Infinity);
  });
});

describe('tiered cost (card 27.5)', () => {
  const pricing = parseCatalogSource(fixture).entries.find(
    (e) => e.key === 'gemini/gemini-2.5-pro',
  )!.pricing;

  it('uses the base rate up to the threshold and the tier rate above it', () => {
    // 200k in + 1k out at 1.25/10
    expect(computeCostUsd(usage(200_000, 1_000), pricing)).toBe('0.26000000');
    // 200,001 in + 1k out at 2.5/15
    expect(computeCostUsd(usage(200_001, 1_000), pricing)).toBe('0.51500250');
    expect(effectivePricing(pricing, 10).inputPerMTok).toBe('1.25');
  });
});
