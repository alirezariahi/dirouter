/**
 * Fake rerankers (card 30.2): `/v1/rerank` answers in Jina's shape (`results`, `usage`) and also
 * Voyage's (`data`), `/v2/rerank` in Cohere's (`results`, `meta.billed_units.search_units`). The
 * score of a document is the share of the query's words it contains, so the ranking is
 * predictable; usage is a quarter of the characters of the query (once per document) and the
 * documents.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export function rerankScore(query: string, document: string): number {
  const q = words(query);
  if (q.size === 0) return 0;
  const d = words(document);
  let hits = 0;
  for (const word of q) if (d.has(word)) hits++;
  return Math.round((hits / q.size) * 1000) / 1000;
}

interface Body {
  model?: string;
  query?: string;
  documents?: (string | { text?: string })[];
  top_n?: number;
  top_k?: number;
}

function rank(body: Body) {
  const query = body.query ?? '';
  const documents = (body.documents ?? []).map((d) => (typeof d === 'string' ? d : (d.text ?? '')));
  const scored = documents
    .map((text, index) => ({ index, relevance_score: rerankScore(query, text), text }))
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
    .slice(0, body.top_n ?? body.top_k ?? documents.length);
  const tokens = documents.reduce(
    (sum, d) => sum + Math.ceil(d.length / 4) + Math.ceil(query.length / 4),
    0,
  );
  return { scored, tokens, documents };
}

const authorized = (req: FastifyRequest) =>
  typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');

export function registerRerank(app: FastifyInstance): void {
  app.post<{ Body: Body }>('/v1/rerank', (req, reply) => {
    if (!authorized(req)) return reply.status(401).send({ detail: 'missing key' });
    const { scored, tokens } = rank(req.body);
    const results = scored.map(({ index, relevance_score }) => ({ index, relevance_score }));
    return {
      model: req.body.model,
      object: 'list',
      results,
      data: results,
      usage: { total_tokens: tokens },
    };
  });
  app.post<{ Body: Body }>('/v2/rerank', (req, reply) => {
    if (!authorized(req)) return reply.status(401).send({ message: 'missing key' });
    const { scored, documents } = rank(req.body);
    return {
      id: `rerank-mock-${Date.now().toString(36)}`,
      results: scored.map(({ index, relevance_score }) => ({ index, relevance_score })),
      meta: {
        api_version: { version: '2' },
        billed_units: { search_units: Math.ceil(documents.length / 100) },
      },
    };
  });
}
