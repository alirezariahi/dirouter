/**
 * Card 31.4: per-model parameter defaults and overrides, and drop_params (organization, header
 * and body), through Traefik against the mock provider.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, request, urls, waitFor } from '../harness.mjs';

export async function register({ scenario, cleanups, org, api, ORG, createKey }) {
  let ready;
  const setup = async () => {
    if (ready) return ready;
    const tag = randomUUID().slice(0, 6);
    const provider = (
      await published(() =>
        org(
          'POST',
          'providers',
          {
            name: `s5-314-${tag}`,
            slug: `s5-314-${tag}`,
            type: 'openai-compatible',
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
            upstreamModel: 'mock-small',
            slug: `s5-314/policy-${tag}`,
            pricing: { inputPerMTok: '1', outputPerMTok: '1' },
            requestPolicy: {
              overrides: { temperature: 0.2 },
              defaults: { max_tokens: 333 },
              unsupported: ['logit_bias'],
            },
          },
          201,
        ),
      )
    ).body;
    const key = (await createKey('314')).key;
    await waitFor('gateway to know the 31.4 model', async () => {
      const res = await fetch(`${urls.gateway}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
      });
      return ((await res.json()).data ?? []).some((m) => m.id === model.slug);
    });
    ready = { key, model: model.slug };
    return ready;
  };
  const lastUpstream = async () =>
    (await request(`${urls.mock}/__mock/stats`, {}, 200)).body.last.at(-1);
  const ask = [{ role: 'user', content: 'hi' }];

  await scenario(
    "31.4 the model's forced value is applied to the request and reported",
    async () => {
      const { key, model } = await setup();
      const res = await chat(key, { model, temperature: 0.9, messages: ask });
      assert.equal(res.response.status, 200, res.text);
      assert.equal(
        res.response.headers.get('x-dirouter-params'),
        'temperature=override, max_tokens=default',
      );
      const sent = await lastUpstream();
      assert.equal(sent.temperature, 0.2);
      assert.equal(sent.max_tokens, 333);
    },
  );

  await scenario(
    '31.4 an unsupported parameter is dropped by default and refused with a clear 400 when drop_params is off',
    async () => {
      const { key, model } = await setup();
      const body = { model, logit_bias: { 42: 5 }, messages: ask };
      const lenient = await chat(key, body);
      assert.equal(lenient.response.status, 200, lenient.text);
      assert.equal((await lastUpstream()).logit_bias, undefined);

      // The organization turns drop_params off; restored right after.
      await published(() => api('PATCH', `orgs/${ORG}`, { dropParams: false }, 200));
      try {
        const strict = await chat(key, body);
        assert.equal(strict.response.status, 400, strict.text);
        assert.equal(
          strict.body.error.message,
          `Unsupported parameter for model '${model}': 'logit_bias'. Remove it, or set drop_params to true to have unsupported parameters dropped.`,
        );
        const header = await chat(key, body, { 'x-dirouter-drop-params': 'true' });
        assert.equal(header.response.status, 200, header.text);
        const inBody = await chat(key, { ...body, drop_params: true });
        assert.equal(inBody.response.status, 200, inBody.text);
        assert.equal((await lastUpstream()).drop_params, undefined);
      } finally {
        await published(() => api('PATCH', `orgs/${ORG}`, { dropParams: true }, 200));
      }
      const refused = await chat(key, { ...body, drop_params: false });
      assert.equal(refused.response.status, 400, refused.text);
    },
  );
}
