/**
 * Card 31.5: model suffixes (:floor, :nitro, :free, reasoning, :online) and service_tier priced
 * from the model's tier prices, through Traefik, the simulator and the request log.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, request, urls, waitFor } from '../harness.mjs';

const ask = (key, body) => chat(key, { messages: [{ role: 'user', content: 'hi' }], ...body });
const lastUpstream = async () =>
  (await request(`${urls.mock}/__mock/stats`, {}, 200)).body.last.at(-1);

export async function register({ scenario, cleanups, org, createKey }) {
  await scenario('31.5 suffixes give the expected result live and in the simulator', async () => {
    const key = await createKey('suffix');
    const sim = (model) => org('POST', 'routes/simulate', { model, virtualKeyId: key.id }, null);
    // :floor on combo `dev` sorts by price, exactly as provider.sort = price does.
    const floor = await sim('dev:floor');
    const sorted = await org('POST', 'routes/simulate', {
      model: 'dev',
      virtualKeyId: key.id,
      provider: { sort: 'price' },
    });
    assert.deepEqual(
      floor.body.candidates.map((c) => c.modelId),
      sorted.body.candidates.map((c) => c.modelId),
    );
    assert.deepEqual(floor.body.suffixes, ['floor']);
    assert.equal((await sim('dev:nitro')).body.suffixes[0], 'nitro');
    assert.equal((await sim('mock/small:thinking')).body.reasoningEffort, 'medium');

    await request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);
    const high = await ask(key.key, { model: 'mock/small:high' });
    assert.equal(high.response.status, 200, high.text);
    assert.equal((await lastUpstream()).reasoning_effort, 'high');
    const floorLive = await ask(key.key, { model: 'dev:floor' });
    assert.equal(floorLive.response.status, 200, floorLive.text);

    // :online needs the web search extension (card 30.8); without it, a clear 400.
    await request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);
    const online = await ask(key.key, { model: 'mock/small:online' });
    if (online.response.status === 400) {
      assert.equal(online.body.error.code, 'web_search_unavailable');
      assert.equal((await request(`${urls.mock}/__mock/stats`, {}, 200)).body.requests, 0);
    } else assert.equal(online.response.status, 200, online.text);
  });

  await scenario(
    '31.5 service_tier is sent upstream and the ledger cost uses the tier price',
    async () => {
      const providers = (await org('GET', 'providers')).body;
      const mock = (Array.isArray(providers) ? providers : providers.items).find(
        (p) => p.slug === 'mock',
      );
      const slug = `s5-tier-${randomUUID().slice(0, 6)}`;
      const model = (
        await published(() =>
          org(
            'POST',
            'models',
            {
              providerId: mock.id,
              upstreamModel: 'mock-small',
              slug,
              pricing: {
                inputPerMTok: '2',
                outputPerMTok: '8',
                serviceTiers: {
                  flex: { inputPerMTok: '1', outputPerMTok: '4' },
                  priority: { inputPerMTok: '3.5', outputPerMTok: '14' },
                },
              },
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
      const key = await createKey('tier');
      for (const [tier, input, output] of [
        ['flex', 1, 4],
        ['priority', 3.5, 14],
      ]) {
        await request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);
        const res = await ask(key.key, { model: slug, service_tier: tier });
        assert.equal(res.response.status, 200, res.text);
        assert.equal((await lastUpstream()).service_tier, tier);
        const id = res.response.headers.get('x-request-id');
        const log = await waitFor('the request log entry', async () => {
          const entry = await org('GET', `logs/${id}`, undefined, null);
          return entry.response.status === 200 ? entry.body : undefined;
        });
        assert.equal(log.serviceTier, tier);
        const expected = (log.inputTokens * input + log.outputTokens * output) / 1_000_000;
        assert.ok(Math.abs(Number(log.costUsd) - expected) < 1e-8, `${log.costUsd} vs ${expected}`);
      }
    },
  );
}
