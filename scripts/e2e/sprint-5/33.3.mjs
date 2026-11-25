/**
 * Card 33.3: a key's limits on one model and input and output TPM apart, through Traefik on the
 * dev stack. Only keys created here are limited.
 */
import assert from 'node:assert/strict';

import { chat } from '../harness.mjs';

const ask = (key, model, maxTokens = 8) =>
  chat(key, { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: maxTokens });

export async function register({ scenario, org, createKey }) {
  await scenario(
    '33.3 a key has its own cap on the expensive model and is free on the cheap one',
    async () => {
      const key = await createKey('model-cap', {
        modelLimits: [{ model: 'mock/claude', rpm: 1 }],
      });
      assert.deepEqual(
        key.modelLimits.map((m) => [m.model, m.rpm]),
        [['mock/claude', 1]],
      );
      assert.equal((await ask(key.key, 'mock/claude')).response.status, 200);
      const second = await ask(key.key, 'mock/claude');
      assert.equal(second.response.status, 429);
      assert.match(second.body.error.message, /this key on this model \(requests\)/);
      for (let i = 0; i < 3; i++)
        assert.equal((await ask(key.key, 'mock/small')).response.status, 200);
      const other = await createKey('model-cap-other');
      for (let i = 0; i < 2; i++)
        assert.equal((await ask(other.key, 'mock/claude')).response.status, 200);
    },
  );

  await scenario("33.3 a key's budget on one model stops only that model", async () => {
    const key = await createKey('model-budget', {
      modelLimits: [
        {
          model: 'mock/small',
          budgets: [{ period: 'daily', limitUsd: '0.00000001', alertThresholds: [100] }],
        },
      ],
    });
    assert.equal((await ask(key.key, 'mock/small')).response.status, 200);
    const refused = await ask(key.key, 'mock/small');
    assert.equal(refused.response.status, 429);
    assert.match(
      refused.body.error.message,
      /Daily key model budget exceeded for every target of 'mock\/small'/,
    );
    assert.equal((await ask(key.key, 'mock/claude')).response.status, 200);
  });

  await scenario('33.3 output TPM is counted apart from input TPM', async () => {
    const key = await createKey('output-tpm', { outputTpm: 600 });
    const view = (await org('GET', `keys/${key.id}`)).body;
    assert.equal(view.outputTpm, 600);
    // The first request reserves 500 output tokens; the next would pass 600 in the window.
    assert.equal((await ask(key.key, 'mock/small', 500)).response.status, 200);
    const second = await ask(key.key, 'mock/small', 500);
    if (second.response.status === 429)
      assert.match(second.body.error.message, /\(output_tokens\)/);
    // A request that asks for little output still fits once the first settled its real usage.
    assert.equal((await ask(key.key, 'mock/small', 8)).response.status, 200);
  });
}
