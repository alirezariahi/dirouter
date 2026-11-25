/**
 * A fake model price list (card 27.5), standing in for LiteLLM's public JSON or an internal mirror,
 * so the catalog sync can be tested end to end without the internet.
 *
 * - `GET /catalog/prices.json` serves the current document (404 until one is set).
 * - `PUT /__mock/catalog` replaces the document with the request body; `{}` clears it.
 */
import type { FastifyInstance } from 'fastify';

export function registerCatalog(app: FastifyInstance): void {
  let document: unknown;

  app.get('/catalog/prices.json', (_req, reply) => {
    if (document === undefined) return reply.status(404).send({ error: 'no price list set' });
    return reply.send(document);
  });

  app.put<{ Body: unknown }>('/__mock/catalog', (req) => {
    const body = req.body;
    document = body && typeof body === 'object' && Object.keys(body).length > 0 ? body : undefined;
    return { ok: true, set: document !== undefined };
  });
}
