/** Rerank adapters (card 30.2): Cohere, Voyage and Jina request and response shapes. */
import type { ModelConfig, ProviderConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { cohereRerank, jinaRerank, rerankAdapterFor, voyageRerank } from './rerank.js';

const ctx = (type: ProviderConfig['type'], baseUrl: string) => ({
  provider: { id: 'p', type, baseUrl, options: {} } as unknown as ProviderConfig,
  model: { upstreamModel: 'rerank-model' } as ModelConfig,
  apiKey: 'k',
});
const req = { query: 'capital of Iran', documents: ['Tehran', 'Paris'], topN: 1 };

describe('rerank adapters', () => {
  it('Cohere: /v2/rerank with top_n, billed in search units', () => {
    const built = cohereRerank.build(ctx('cohere', 'https://api.cohere.com'), {
      ...req,
      maxTokensPerDoc: 512,
    });
    expect(built.url).toBe('https://api.cohere.com/v2/rerank');
    expect(built.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(built.body ?? '')).toEqual({
      model: 'rerank-model',
      query: 'capital of Iran',
      documents: ['Tehran', 'Paris'],
      top_n: 1,
      max_tokens_per_doc: 512,
    });
    expect(
      cohereRerank.parse({
        id: 'x',
        results: [
          { index: 1, relevance_score: 0.1 },
          { index: 0, relevance_score: 0.9 },
        ],
        meta: { billed_units: { search_units: 1 } },
      }),
    ).toEqual({
      results: [
        { index: 0, relevanceScore: 0.9 },
        { index: 1, relevanceScore: 0.1 },
      ],
      searchUnits: 1,
    });
  });

  it('Voyage: /rerank with top_k, data[] and tokens', () => {
    const built = voyageRerank.build(ctx('voyage', 'https://api.voyageai.com/v1'), req);
    expect(built.url).toBe('https://api.voyageai.com/v1/rerank');
    expect(JSON.parse(built.body ?? '')).toMatchObject({ top_k: 1 });
    expect(
      voyageRerank.parse({
        object: 'list',
        data: [{ index: 0, relevance_score: 0.8 }],
        usage: { total_tokens: 12 },
      }),
    ).toEqual({ results: [{ index: 0, relevanceScore: 0.8 }], tokens: 12 });
  });

  it('Jina: /rerank with top_n, results[] and tokens', () => {
    const built = jinaRerank.build(ctx('jina', 'https://api.jina.ai/v1/'), req);
    expect(built.url).toBe('https://api.jina.ai/v1/rerank');
    expect(JSON.parse(built.body ?? '')).toMatchObject({ top_n: 1, return_documents: false });
    expect(
      jinaRerank.parse({
        results: [{ index: 0, relevance_score: 0.7, document: { text: 'Tehran' } }],
        usage: { total_tokens: 9 },
      }),
    ).toEqual({ results: [{ index: 0, relevanceScore: 0.7 }], tokens: 9 });
    expect(() => jinaRerank.parse({})).toThrow(/no results/);
  });

  it('serves Cohere, Voyage, Jina, OpenAI-compatible servers and the mock', () => {
    expect(rerankAdapterFor('cohere')).toBe(cohereRerank);
    expect(rerankAdapterFor('openai-compatible')).toBe(jinaRerank);
    expect(rerankAdapterFor('openai')).toBeUndefined();
  });
});
