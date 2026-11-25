/**
 * Card 32.5: routing by data policy and region. With a ZDR-only policy a request never reaches a
 * provider without zero data retention, not even as a fallback, and a request cannot weaken it.
 */
import assert from 'node:assert/strict';

import { chat, published, request, urls, waitFor } from '../harness.mjs';

const ask = (key, body) => chat(key, { messages: [{ role: 'user', content: 'hi' }], ...body });
const upstreamCalls = async () =>
  (await request(`${urls.mock}/__mock/stats`, {}, 200)).body.requests;

export async function register({ scenario, cleanups, org, createKey }) {
  await scenario('32.5 a ZDR-only key never falls back to a provider without ZDR', async () => {
    const providers = (await org('GET', 'providers')).body;
    const list = Array.isArray(providers) ? providers : providers.items;
    const byslug = (slug) => list.find((p) => p.slug === slug);
    const down = byslug('mock-down');
    const small = byslug('mock');
    assert.ok(down && small, 'the seed providers mock and mock-down exist');
    const setMeta = (p, dataPolicy) =>
      published(() => org('PATCH', `providers/${p.id}`, { dataPolicy }));
    cleanups.push(() => org('PATCH', `providers/${down.id}`, { dataPolicy: null }, null));
    cleanups.push(() => org('PATCH', `providers/${small.id}`, { dataPolicy: null }, null));
    await setMeta(down, { region: 'eu', country: 'DE', zdr: true, trainsOnData: false });
    await setMeta(small, { region: 'us', country: 'US', zdr: false, trainsOnData: true });

    const key = await createKey('zdr');
    cleanups.push(() =>
      org('PUT', 'routing-policies', { scope: 'key', scopeId: key.id, policy: null }, null),
    );
    await published(() =>
      org('PUT', 'routing-policies', {
        scope: 'key',
        scopeId: key.id,
        policy: { dataPolicy: { requireZdr: true } },
      }),
    );

    // Earlier scenarios (the 32.3 canary on mock/down) may have opened the breakers of mock-down;
    // the request must reach it, so start from closed breakers.
    const resetBreaker = async () => {
      await org('POST', 'health/reset', { scope: 'provider', id: 'prv_mock-down' }, 200);
      await org('POST', 'health/reset', { scope: 'model', id: 'mdl_dev_mock_down' }, 200);
    };
    await resetBreaker();
    // combo `dev`: mock-down (ZDR, answers 503), then mock/small (no ZDR). The fallback is cut.
    await request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);
    const res = await ask(key.key, { model: 'dev' });
    assert.ok(res.response.status >= 500, res.text);
    const stats = (await request(`${urls.mock}/__mock/stats`, {}, 200)).body;
    assert.deepEqual(Object.keys(stats.byKey).length, 1, JSON.stringify(stats.byKey));
    // The request log keeps the policy and the removed target.
    const requestId = res.response.headers.get('x-request-id');
    const logged = await waitFor('the request log entry', async () => {
      const entry = await org('GET', `logs/${requestId}`, undefined, null);
      return entry.response.status === 200 ? entry.body : undefined;
    });
    assert.deepEqual(logged.routeDecision.dataPolicy, { requireZdr: true });
    assert.ok(logged.routeDecision.skipped.some((s) => s.reason === 'not_zdr'));

    // The client cannot relax it.
    const weaker = await ask(key.key, {
      model: 'mock/small',
      provider: { zdr: false, data_collection: 'allow' },
    });
    assert.equal(weaker.response.status, 400, weaker.text);
    assert.equal(weaker.body.error.code, 'no_provider_matches_data_policy');

    // The simulator shows the policy and the reason.
    const sim = await org('POST', 'routes/simulate', { model: 'dev', virtualKeyId: key.id });
    assert.deepEqual(sim.body.dataPolicy, { requireZdr: true });
    assert.ok(
      sim.body.skipped.some((s) => s.reason === 'not_zdr'),
      JSON.stringify(sim.body),
    );

    // An open key asks for EU providers itself.
    const open = await createKey('region');
    await request(`${urls.mock}/__mock/reset`, { method: 'POST' }, 200);
    const eu = await ask(open.key, { model: 'mock/small', provider: { regions: ['eu'] } });
    assert.equal(eu.response.status, 400, eu.text);
    assert.equal(await upstreamCalls(), 0);
  });
}
