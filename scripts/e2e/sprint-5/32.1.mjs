/**
 * Card 32.1: provider preferences in the request body, the `models` fallback array and the
 * administrator's lock on a key, live through Traefik and in the routing simulator.
 */
import assert from 'node:assert/strict';

import { chat, published, request, urls } from '../harness.mjs';

const ask = (key, body, headers) =>
  chat(key, { messages: [{ role: 'user', content: 'hi' }], ...body }, headers);

export async function register({ scenario, cleanups, org, createKey }) {
  await scenario(
    '32.1 an OpenRouter-format request works and no provider sees the routing fields',
    async () => {
      const key = await createKey('prefs');
      await request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);
      const res = await ask(key.key, {
        model: 'dev',
        models: ['mock/small'],
        route: 'fallback',
        provider: {
          order: ['mock'],
          allow_fallbacks: true,
          require_parameters: false,
          data_collection: 'allow',
          sort: 'price',
        },
      });
      assert.equal(res.response.status, 200, res.text);
      assert.equal(res.response.headers.get('x-dirouter-provider'), 'mock');
      const upstream = (await request(`${urls.mock}/__mock/stats`, {}, 200)).body.last.at(-1);
      for (const field of ['provider', 'models', 'route'])
        assert.ok(!(field in upstream), `the provider received ${field}`);
    },
  );

  await scenario(
    '32.1 order, ignore and allow_fallbacks change the target, live and simulated',
    async () => {
      const key = await createKey('prefs-order');
      // combo `dev` tries mock-down (503) first; ignoring it means a single, successful attempt.
      const ignored = await ask(key.key, { model: 'dev', provider: { ignore: ['mock-down'] } });
      assert.equal(ignored.response.status, 200, ignored.text);
      assert.equal(ignored.response.headers.get('x-dirouter-attempts'), '1');
      const strict = await ask(key.key, {
        model: 'dev',
        provider: { order: ['mock-down'], allow_fallbacks: false },
      });
      assert.notEqual(strict.response.status, 200, 'no fallback was allowed');
      const sim = await org('POST', 'routes/simulate', {
        model: 'dev',
        virtualKeyId: key.id,
        provider: { order: ['mock'] },
      });
      assert.equal(sim.body.candidates[0].provider, 'mock', JSON.stringify(sim.body));
      assert.deepEqual(sim.body.preferences, { order: ['mock'] });
    },
  );

  await scenario('32.1 preferences that leave nothing fail with a clear 400', async () => {
    const key = await createKey('prefs-none');
    const res = await ask(key.key, { model: 'dev', provider: { only: ['no-such-provider'] } });
    assert.equal(res.response.status, 400, res.text);
    assert.equal(res.body.error.code, 'no_provider_matches_preferences');
    assert.match(res.body.error.message, /provider_not_in_only/);
    const priced = await ask(key.key, {
      model: 'mock/small',
      provider: { max_price: { prompt: 0 } },
    });
    // A free mock model passes a zero price cap; a priced one is removed with a clear reason.
    if (priced.response.status !== 200) {
      assert.equal(priced.response.status, 400, priced.text);
      assert.match(priced.body.error.message, /above_max_price_prompt/);
    }
  });

  await scenario('32.1 the models array falls back to the next model', async () => {
    const key = await createKey('prefs-models');
    const res = await ask(key.key, { model: 'mock/down', models: ['mock/small'] });
    assert.equal(res.response.status, 200, res.text);
    assert.equal(res.response.headers.get('x-dirouter-model'), 'mock/small');
  });

  await scenario('32.1 a locked key policy cannot be bypassed by the client', async () => {
    const key = await createKey('prefs-locked');
    const set = (policy) =>
      published(() => org('PUT', 'routing-policies', { scope: 'key', scopeId: key.id, policy }));
    cleanups.push(() =>
      org('PUT', 'routing-policies', { scope: 'key', scopeId: key.id, policy: null }, null),
    );
    await set({ provider: { ignore: ['mock-down'] }, lockProvider: true });
    const res = await ask(key.key, {
      model: 'dev',
      provider: { order: ['mock-down'], allow_fallbacks: false },
    });
    assert.equal(res.response.status, 200, res.text);
    assert.equal(res.response.headers.get('x-dirouter-preferences'), 'locked');
    assert.equal(res.response.headers.get('x-dirouter-provider'), 'mock');
    const listed = await org('GET', 'routing-policies');
    assert.ok(listed.body.policies.some((p) => p.scopeId === key.id && p.policy.lockProvider));
    await set(null);
  });
}
