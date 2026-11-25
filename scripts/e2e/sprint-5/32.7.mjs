/**
 * Card 32.7: the routing decision in the response. With the key's permission and the request
 * header it matches the simulator; without either, nothing internal comes back.
 */
import assert from 'node:assert/strict';

import { chat, published, waitFor } from '../harness.mjs';

const decode = (response) => {
  const header = response.headers.get('x-dirouter-routing');
  return header ? JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) : undefined;
};
const ASK = { 'x-dirouter-explain': '1' };
const body = { model: 'dev', messages: [{ role: 'user', content: 'hi' }] };

export async function register({ scenario, cleanups, org, createKey }) {
  await scenario('32.7 the explanation matches the simulator and the request log', async () => {
    const key = await createKey('explain');
    cleanups.push(() =>
      org('PUT', 'routing-policies', { scope: 'key', scopeId: key.id, policy: null }, null),
    );
    await published(() =>
      org('PUT', 'routing-policies', { scope: 'key', scopeId: key.id, policy: { explain: true } }),
    );
    const res = await chat(key.key, body, ASK);
    assert.equal(res.response.status, 200, res.text);
    const live = decode(res.response);
    assert.ok(live, 'x-dirouter-routing is present');
    const { attempts, ...plan } = live;
    // combo `dev`: mock-down fails, then mock/small answers.
    assert.deepEqual(
      attempts.map((a) => a.outcome),
      ['error', 'success'],
    );
    const sim = await org('POST', 'routes/simulate', {
      model: 'dev',
      virtualKeyId: key.id,
      estimatedInputTokens: plan.estimate.inputTokens,
    });
    assert.deepEqual(plan, sim.body.explanation);
    const id = res.response.headers.get('x-request-id');
    const logged = await waitFor('the request log entry', async () => {
      const entry = await org('GET', `logs/${id}`, undefined, null);
      return entry.response.status === 200 ? entry.body : undefined;
    });
    assert.deepEqual(
      logged.routeDecision.candidates.map((c) => c.modelId),
      plan.candidates.map((c) => c.modelId),
    );
    assert.equal(logged.routeDecision.estimatedCostUsd, plan.estimatedCostUsd);
  });

  await scenario('32.7 without the permission no internal information is returned', async () => {
    const key = await createKey('no-explain');
    const res = await chat(key.key, body, ASK);
    assert.equal(res.response.status, 200, res.text);
    assert.equal(res.response.headers.get('x-dirouter-routing'), null);
    assert.ok(!res.text.includes('credentialId') && !res.text.includes('candidates'), res.text);
  });
}
