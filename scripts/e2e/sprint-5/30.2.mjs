/**
 * Card 30.2: rerank through Traefik. The official Cohere SDK, pointed at the gateway, reranks on
 * a Cohere-type target billed per search unit; a Jina-style call on a Jina-type target is billed
 * per token; the key's requests-per-minute limit stops the next call.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { published, request, root, sql, urls, waitFor } from '../harness.mjs';

export async function register({ scenario, cleanups, org, createKey }) {
  const require = createRequire(join(root, 'apps/gateway/package.json'));
  const { CohereClientV2 } = require('cohere-ai');
  const tag = randomUUID().slice(0, 6);

  async function rerankModel(type, baseUrl, pricing) {
    const provider = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5-rerank-${type}-${tag}`,
            slug: `s5-rerank-${type}-${tag}`,
            type,
            baseUrl,
            credentials: [{ name: 'k', secret: 'sk-mock' }],
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
    const model = (
      await published(() =>
        org(
          'POST',
          'models',
          {
            providerId: provider.id,
            upstreamModel: `${type}-reranker`,
            slug: `s5-rerank-${type}-${tag}`,
            pricing: { inputPerMTok: '0', outputPerMTok: '0', ...pricing },
            capabilities: { rerank: true },
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
    return model;
  }

  const documents = ['Paris is the capital of France', 'Tehran is the capital of Iran'];

  await scenario(
    '30.2 the Cohere SDK reranks through DiRouter; cost and limits apply',
    async () => {
      const cohereModel = await rerankModel('cohere', 'http://mock-provider:8090', {
        perSearchUsd: '0.002',
      });
      const jinaModel = await rerankModel('jina', 'http://mock-provider:8090/v1', {
        inputPerMTok: '0.02',
      });
      const key = await createKey('rerank', { rpm: 2 });
      const cohere = new CohereClientV2({ token: key.key, environment: urls.gateway });
      const ranked = await cohere.rerank({
        model: cohereModel.slug,
        query: 'capital of Iran',
        documents,
        topN: 1,
      });
      assert.equal(ranked.results[0].index, 1);
      assert.equal(ranked.meta.billedUnits.searchUnits, 1);

      const jina = await request(
        `${urls.gateway}/v1/rerank`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: jinaModel.slug, query: 'capital of France', documents }),
        },
        200,
      );
      assert.equal(jina.body.results[0].index, 0);
      assert.equal(jina.body.results[0].document.text, documents[0]);
      const tokens = jina.body.usage.total_tokens;

      // The third call in the minute is over the key's limit.
      await request(
        `${urls.gateway}/v1/rerank`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: jinaModel.slug, query: 'x', documents }),
        },
        429,
      );

      await waitFor(
        'both calls in the request log',
        async () =>
          Number(
            await sql(
              `SELECT count(*) FROM request_log WHERE api_key_id = '${key.id}' AND inbound_api = 'rerank'`,
            ),
          ) === 2,
      );
      const costs = (
        await sql(
          `SELECT model_id, cost_usd FROM request_log WHERE api_key_id = '${key.id}' AND inbound_api = 'rerank'`,
        )
      )
        .split('\n')
        .map((line) => line.split('|'));
      const cost = (modelId) => Number(costs.find(([id]) => id === modelId)?.[1]);
      assert.equal(cost(cohereModel.id), 0.002);
      assert.ok(Math.abs(cost(jinaModel.id) - (tokens * 0.02) / 1e6) < 1e-8);
    },
  );
}
