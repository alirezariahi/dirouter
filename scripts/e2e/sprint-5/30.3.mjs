/**
 * Card 30.3: `/v1/moderations` through Traefik with the official OpenAI SDK unchanged — a string
 * with the default model name, an array, and multimodal parts — routed to the configured
 * moderation model and recorded under the key.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { published, root, sql, urls, waitFor } from '../harness.mjs';

export async function register({ scenario, cleanups, org, createKey }) {
  const require = createRequire(join(root, 'apps/gateway/package.json'));
  const { default: OpenAI } = require('openai');
  const tag = randomUUID().slice(0, 6);

  await scenario(
    '30.3 the OpenAI SDK calls /v1/moderations through DiRouter unchanged',
    async () => {
      const provider = (
        await published(() =>
          org(
            'POST',
            'providers',
            {
              name: `s5-moderation-${tag}`,
              slug: `s5-moderation-${tag}`,
              type: 'openai',
              baseUrl: 'http://mock-provider:8090/v1',
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
              upstreamModel: 'omni-moderation-latest',
              slug: `s5-moderation-${tag}`,
              pricing: { inputPerMTok: '0', outputPerMTok: '0' },
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
      const key = await createKey('moderations');
      const client = new OpenAI({ apiKey: key.key, baseURL: `${urls.gateway}/v1`, maxRetries: 0 });

      const one = await client.moderations.create({ model: model.slug, input: 'we kill' });
      assert.equal(one.results.length, 1);
      assert.equal(one.results[0].flagged, true);
      assert.equal(one.results[0].categories.violence, true);
      assert.deepEqual(one.results[0].category_applied_input_types.violence, ['text']);

      const many = await client.moderations.create({
        model: model.slug,
        input: ['hello', 'we kill'],
      });
      assert.deepEqual(
        many.results.map((r) => r.flagged),
        [false, true],
      );

      const parts = await client.moderations.create({
        model: model.slug,
        input: [
          { type: 'text', text: 'a cat' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ],
      });
      assert.equal(parts.results.length, 1);
      assert.deepEqual(parts.results[0].category_applied_input_types.violence, ['text', 'image']);

      await waitFor(
        'the calls in the request log',
        async () =>
          Number(
            await sql(
              `SELECT count(*) FROM request_log WHERE api_key_id = '${key.id}' AND inbound_api = 'openai.moderations'`,
            ),
          ) >= 3,
      );
    },
  );
}
