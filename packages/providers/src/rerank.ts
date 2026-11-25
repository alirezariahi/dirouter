/**
 * Rerank adapters (card 30.2): Cohere, Voyage AI and Jina AI (the providers DiRouter already uses
 * for embeddings), and OpenAI-compatible servers that expose the Jina/Cohere-shaped `/rerank`
 * (vLLM, Infinity, Text Embeddings Inference behind a router), plus the mock.
 *
 * | type                     | Upstream                    | Billed by                     |
 * | ------------------------ | --------------------------- | ----------------------------- |
 * | cohere                   | `POST /v2/rerank`           | search units (`billed_units`) |
 * | voyage                   | `POST /rerank` (`top_k`)    | tokens (`usage.total_tokens`) |
 * | jina, openai-compatible, mock | `POST /rerank` (`top_n`) | tokens (`usage.total_tokens`) |
 */
import type { ProviderType } from '@dirouter/contracts';

import type { UpstreamRequest } from './adapters.js';
import type { MediaContext } from './media.js';
import { presetFor } from './presets.js';

export interface RerankRequest {
  query: string;
  documents: string[];
  topN?: number;
  /** Cohere: longer documents are truncated to this many tokens. */
  maxTokensPerDoc?: number;
}

export interface RerankResult {
  /** Best first, as the provider ranked them. */
  results: { index: number; relevanceScore: number }[];
  /** Tokens the provider billed. */
  tokens?: number;
  /** Search units the provider billed (Cohere). */
  searchUnits?: number;
}

export interface RerankAdapter {
  build(ctx: MediaContext, req: RerankRequest): UpstreamRequest;
  parse(json: unknown): RerankResult;
  /** Most documents one call accepts. */
  maxDocuments: number;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const post = (url: string, ctx: MediaContext, body: unknown): UpstreamRequest => ({
  url,
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
    ...(ctx.provider.type === 'openai-compatible' ? presetFor(ctx.provider).headers : {}),
    ...ctx.credentialHeaders,
  },
  body: JSON.stringify(body),
});

function ranked(list: unknown): RerankResult['results'] {
  if (!Array.isArray(list)) throw new Error('rerank response has no results');
  return list
    .map((r) => ({
      index: num(rec(r).index) ?? -1,
      relevanceScore: num(rec(r).relevance_score) ?? 0,
    }))
    .filter((r) => r.index >= 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/** `{results, usage: {total_tokens}}` (Jina, vLLM, Infinity) or `{data, usage}` (Voyage). */
function parseTokenBilled(json: unknown): RerankResult {
  const body = rec(json);
  const tokens = num(rec(body.usage).total_tokens) ?? num(rec(body.usage).prompt_tokens);
  return {
    results: ranked(body.results ?? body.data),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

export const cohereRerank: RerankAdapter = {
  maxDocuments: 1000,
  build: (ctx, req) =>
    post(`${trimSlash(ctx.provider.baseUrl)}/v2/rerank`, ctx, {
      model: ctx.model.upstreamModel,
      query: req.query,
      documents: req.documents,
      ...(req.topN !== undefined ? { top_n: req.topN } : {}),
      ...(req.maxTokensPerDoc !== undefined ? { max_tokens_per_doc: req.maxTokensPerDoc } : {}),
    }),
  parse: (json) => {
    const body = rec(json);
    const billed = rec(rec(body.meta).billed_units);
    const searchUnits = num(billed.search_units);
    return {
      results: ranked(body.results),
      ...(searchUnits !== undefined ? { searchUnits } : {}),
    };
  },
};

export const voyageRerank: RerankAdapter = {
  maxDocuments: 1000,
  build: (ctx, req) =>
    post(`${trimSlash(ctx.provider.baseUrl)}/rerank`, ctx, {
      model: ctx.model.upstreamModel,
      query: req.query,
      documents: req.documents,
      ...(req.topN !== undefined ? { top_k: req.topN } : {}),
    }),
  parse: parseTokenBilled,
};

export const jinaRerank: RerankAdapter = {
  maxDocuments: 2048,
  build: (ctx, req) =>
    post(`${trimSlash(ctx.provider.baseUrl)}/rerank`, ctx, {
      model: ctx.model.upstreamModel,
      query: req.query,
      documents: req.documents,
      ...(req.topN !== undefined ? { top_n: req.topN } : {}),
      return_documents: false,
    }),
  parse: parseTokenBilled,
};

const RERANK: Partial<Record<ProviderType, RerankAdapter>> = {
  cohere: cohereRerank,
  voyage: voyageRerank,
  jina: jinaRerank,
  'openai-compatible': jinaRerank,
  mock: jinaRerank,
};

export function rerankAdapterFor(type: ProviderType): RerankAdapter | undefined {
  return RERANK[type];
}
