/**
 * Rerank (card 30.2): `POST /v1/rerank` and `POST /v2/rerank`, compatible with Cohere's SDKs
 * (`CohereClient` calls `/v1/rerank`, `CohereClientV2` calls `/v2/rerank`) and with Jina's API
 * (`/v1/rerank`), with the gateway's root as their base URL.
 *
 * It runs through the shared metered pipeline (metered.ts): the key, routing with fallback, rate
 * limits (the input counts against TPM), budgets, the wallet and a usage event. A model is offered
 * when its `rerank` capability is on and its provider has a rerank adapter. The cost is the
 * provider's billed tokens at the input price plus its search units at the per-search price;
 * whatever the provider does not report is estimated.
 */
import { type RerankResult, rerankAdapterFor } from '@dirouter/providers';
import { DiRouterError, ValidationError } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { capable, runMetered } from './metered.js';
import type { ProxyDeps } from './proxy.js';

export const MAX_RERANK_DOCUMENTS = 1_000;
/** Cohere counts one search unit per query and up to 100 documents. */
const DOCUMENTS_PER_SEARCH = 100;

const invalid = (path: string, message: string) => new ValidationError([{ path, message }]);

interface ParsedRerank {
  model: string;
  query: string;
  documents: string[];
  topN?: number;
  maxTokensPerDoc?: number;
  returnDocuments: boolean;
}

/**
 * The request in Cohere (v1 and v2) or Jina form. Documents are strings or objects: `{text}`
 * (Jina, Cohere v1) or, for Cohere v1 with `rank_fields`, the listed fields as `key: value` lines.
 */
export function parseRerank(body: unknown, version: 'v1' | 'v2'): ParsedRerank {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.model !== 'string' || b.model === '') throw invalid('model', 'model is required');
  if (typeof b.query !== 'string' || b.query === '') throw invalid('query', 'query is required');
  if (!Array.isArray(b.documents) || b.documents.length === 0)
    throw invalid('documents', 'documents must be a non-empty array');
  if (b.documents.length > MAX_RERANK_DOCUMENTS)
    throw invalid('documents', `at most ${String(MAX_RERANK_DOCUMENTS)} documents per request`);
  const fields = Array.isArray(b.rank_fields)
    ? b.rank_fields.filter((f): f is string => typeof f === 'string')
    : [];
  const documents = b.documents.map((doc, i) => {
    if (typeof doc === 'string') return doc;
    const d = (doc ?? {}) as Record<string, unknown>;
    if (fields.length > 0)
      return fields
        .map((f) => `${f}: ${typeof d[f] === 'string' ? d[f] : JSON.stringify(d[f] ?? '')}`)
        .join('\n');
    if (typeof d.text === 'string') return d.text;
    throw invalid(`documents.${String(i)}`, 'a document is a string or an object with text');
  });
  const topN = b.top_n ?? b.top_k;
  if (topN !== undefined && (typeof topN !== 'number' || !Number.isInteger(topN) || topN < 1))
    throw invalid('top_n', 'top_n must be a positive integer');
  const maxTokens = b.max_tokens_per_doc ?? b.max_chunks_per_doc;
  if (maxTokens !== undefined && (typeof maxTokens !== 'number' || maxTokens < 1))
    throw invalid('max_tokens_per_doc', 'max_tokens_per_doc must be a positive integer');
  return {
    model: b.model,
    query: b.query,
    documents,
    ...(typeof topN === 'number' ? { topN: Math.min(topN, documents.length) } : {}),
    ...(typeof b.max_tokens_per_doc === 'number' ? { maxTokensPerDoc: b.max_tokens_per_doc } : {}),
    // Cohere v1 and Jina return the documents unless told not to; Cohere v2 never does.
    returnDocuments: version === 'v1' ? b.return_documents !== false : b.return_documents === true,
  };
}

const tokensOf = (text: string) => Math.ceil(text.length / 4);

export async function handleRerank(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  version: 'v1' | 'v2',
): Promise<void> {
  let input: ParsedRerank;
  try {
    input = parseRerank(req.body, version);
  } catch (error) {
    const e = error instanceof DiRouterError ? error : new DiRouterError('invalid_request');
    reply.status(e.status).send(e.toOpenAI());
    return;
  }
  // The provider reads the query with every document.
  const estimatedTokens = input.documents.reduce(
    (sum, doc) => sum + tokensOf(doc) + tokensOf(input.query),
    0,
  );
  const searches = Math.ceil(input.documents.length / DOCUMENTS_PER_SEARCH);

  const result = await runMetered<RerankResult>(req, deps, {
    inboundApi: 'rerank',
    model: input.model,
    estimatedInputTokens: estimatedTokens,
    worstCase: { usage: { inputTokens: estimatedTokens }, media: { searches }, estimated: true },
    select: (candidates) =>
      capable(
        candidates,
        (c) =>
          c.model.capabilities.rerank === true &&
          input.documents.length <= (rerankAdapterFor(c.provider.type)?.maxDocuments ?? 0),
        'rerank',
        input.model,
      ),
    build: (candidate, apiKey) =>
      rerankAdapterFor(candidate.provider.type)?.build(
        {
          provider: candidate.provider,
          model: candidate.model,
          apiKey,
          credentialHeaders: candidate.credential.headers,
        },
        {
          query: input.query,
          documents: input.documents,
          ...(input.topN !== undefined ? { topN: input.topN } : {}),
          ...(input.maxTokensPerDoc !== undefined
            ? { maxTokensPerDoc: input.maxTokensPerDoc }
            : {}),
        },
      ),
    read: async (response, candidate) => {
      const adapter = rerankAdapterFor(candidate.provider.type);
      if (!adapter) throw new Error('rerank not supported');
      return adapter.parse(await response.json());
    },
    // What the provider billed: its tokens at the input price, its search units at the search
    // price; each is estimated when the provider does not report it.
    meter: (value) => ({
      usage: { inputTokens: value.tokens ?? estimatedTokens },
      media: { searches: value.searchUnits ?? searches },
      estimated: value.tokens === undefined && value.searchUnits === undefined,
    }),
  });
  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  if (!result.ok) {
    reply.status(result.error.status).send(result.error.toOpenAI());
    return;
  }
  void reply
    .header('x-dirouter-model', result.candidate.model.slug)
    .header('x-dirouter-provider', result.candidate.provider.slug);
  const results = result.value.results
    .filter((r) => r.index < input.documents.length)
    .slice(0, input.topN ?? input.documents.length)
    .map((r) => ({
      index: r.index,
      relevance_score: r.relevanceScore,
      ...(input.returnDocuments ? { document: { text: input.documents[r.index] } } : {}),
    }));
  const tokens = result.metering.usage.inputTokens ?? 0;
  // One body for every client: Cohere reads `id`, `results` and `meta`; Jina `model`, `results`
  // and `usage`.
  reply.status(200).send({
    id: req.id,
    model: input.model,
    results,
    meta: {
      api_version: { version: version === 'v2' ? '2' : '1' },
      billed_units: { search_units: result.metering.media?.searches ?? searches },
    },
    usage: { total_tokens: tokens, prompt_tokens: tokens },
  });
}

export function registerRerankRoutes(app: FastifyInstance, deps: ProxyDeps): void {
  app.post('/v1/rerank', (req, reply) => handleRerank(req, reply, deps, 'v1'));
  app.post('/v2/rerank', (req, reply) => handleRerank(req, reply, deps, 'v2'));
}
