/**
 * Fake web search backends and web pages (card 30.8), so web search and fetch can be tested
 * without the internet.
 *
 * - `GET /web/searxng/search?q=&format=json` — SearXNG JSON API.
 * - `GET /web/brave/res/v1/web/search?q=&count=` — Brave Search API (`x-subscription-token`).
 * - `POST /web/tavily/search` — Tavily API (`Authorization: Bearer`).
 * - `GET /web/page/{n}` — an HTML page (title, script, entities); results link to these pages.
 * - `GET /web/redirect?to=` — a 302 to `to`; `GET /web/big` — 3 MiB of text;
 *   `GET /web/binary` — an octet stream; `GET /web/slow` — answers after 5 seconds.
 * - `PUT /__mock/web` `{ "fail": ["searxng"] }` makes backends answer 503;
 *   `GET /__mock/web` returns the calls per backend.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import type { FastifyInstance, FastifyRequest } from 'fastify';

type Backend = 'searxng' | 'brave' | 'tavily';

export function registerWeb(app: FastifyInstance): void {
  let failing = new Set<string>();
  const calls: Record<Backend, number> = { searxng: 0, brave: 0, tavily: 0 };

  const origin = (req: FastifyRequest) =>
    `${req.protocol}://${req.headers.host ?? 'mock-provider:8090'}`;
  const results = (req: FastifyRequest, query: string, backend: Backend) =>
    [1, 2, 3].map((n) => ({
      title: `${backend} result ${String(n)} for ${query}`,
      url: `${origin(req)}/web/page/${String(n)}?q=${encodeURIComponent(query)}`,
      snippet: `Snippet ${String(n)} from ${backend} about ${query}.`,
      published: '2026-11-20',
    }));

  app.get<{ Querystring: { q?: string; format?: string } }>('/web/searxng/search', (req, reply) => {
    calls.searxng++;
    if (failing.has('searxng')) return reply.status(503).send({ error: 'unavailable' });
    if (req.query.format !== 'json') return reply.status(403).send('json format disabled');
    return {
      query: req.query.q ?? '',
      results: results(req, req.query.q ?? '', 'searxng').map((r) => ({
        title: r.title,
        url: r.url,
        content: r.snippet,
        publishedDate: r.published,
      })),
    };
  });

  app.get<{ Querystring: { q?: string; count?: string } }>(
    '/web/brave/res/v1/web/search',
    (req, reply) => {
      calls.brave++;
      if (failing.has('brave')) return reply.status(503).send({ error: 'unavailable' });
      if (!req.headers['x-subscription-token'])
        return reply.status(401).send({ error: 'missing token' });
      return {
        web: {
          results: results(req, req.query.q ?? '', 'brave').map((r) => ({
            title: r.title,
            url: r.url,
            description: r.snippet,
            page_age: r.published,
          })),
        },
      };
    },
  );

  app.post<{ Body: { query?: string; max_results?: number } }>(
    '/web/tavily/search',
    (req, reply) => {
      calls.tavily++;
      if (failing.has('tavily')) return reply.status(503).send({ error: 'unavailable' });
      if (!/^Bearer \S+/.test(req.headers.authorization ?? ''))
        return reply.status(401).send({ error: 'missing key' });
      const query = req.body.query ?? '';
      return {
        query,
        results: results(req, query, 'tavily').map((r) => ({
          title: r.title,
          url: r.url,
          content: r.snippet,
          published_date: r.published,
        })),
      };
    },
  );

  app.get<{ Params: { n: string } }>('/web/page/:n', (req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html><head><title>Mock page ${req.params.n}</title>` +
          `<script>var secret = "never shown";</script><style>p{color:red}</style></head>` +
          `<body><h1>Page ${req.params.n}</h1><p>Facts &amp; figures for the web fetch test.</p>` +
          `<p>Second paragraph.</p></body></html>`,
      ),
  );
  app.get<{ Querystring: { to?: string } }>('/web/redirect', (req, reply) =>
    reply.redirect(req.query.to ?? '/web/page/1', 302),
  );
  app.get('/web/big', (_req, reply) => reply.type('text/plain').send('x'.repeat(3 * 1_048_576)));
  app.get('/web/binary', (_req, reply) =>
    reply.type('application/octet-stream').send(Buffer.alloc(64)),
  );
  app.get('/web/slow', async (_req, reply) => {
    await sleep(5_000);
    return reply.type('text/plain').send('late');
  });

  app.put<{ Body: { fail?: string[] } }>('/__mock/web', (req) => {
    failing = new Set(req.body.fail ?? []);
    return { ok: true, failing: [...failing] };
  });
  app.get('/__mock/web', () => ({ calls, failing: [...failing] }));
}
