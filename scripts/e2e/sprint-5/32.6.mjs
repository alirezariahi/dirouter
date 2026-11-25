/**
 * Card 32.6: budgets and quota windows of upstream credentials, and the fill-first order, through
 * Traefik on the dev stack. Each scenario creates its own provider (two API-key credentials on the
 * mock provider) and model with names unique to the run, and deletes them at the end. Which
 * credential served a request is read from the gateway's quota window counters in Valkey.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, valkey, waitFor } from '../harness.mjs';

const ask = (key, model) =>
  chat(key, { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 });

export async function register({ scenario, cleanups, org, createKey }) {
  /** A provider with two credentials and one model on it, removed by the cleanups. */
  async function plan(name) {
    const run = randomUUID().slice(0, 8);
    const provider = (
      await org(
        'POST',
        'providers',
        {
          name: `e2e-${name}-${run}`,
          type: 'openai-compatible',
          baseUrl: 'http://mock-provider:8090/v1',
          credentials: [
            { name: 'seat-1', secret: 'mock-secret-1', weight: 2 },
            { name: 'seat-2', secret: 'mock-secret-2', weight: 1 },
          ],
        },
        201,
      )
    ).body;
    cleanups.push(() => org('DELETE', `providers/${provider.id}`, undefined, null));
    const seat = (n) => provider.credentials.find((c) => c.name === n).id;
    const model = (
      await published(() =>
        org(
          'POST',
          'models',
          {
            providerId: provider.id,
            upstreamModel: 'mock-small',
            slug: `e2e-${name}-${run}/small`,
            // About a cent per request, so a tiny budget is used up by the first one.
            pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
            capabilities: {},
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
    return { provider, seats: [seat('seat-1'), seat('seat-2')], model: model.slug };
  }
  const used = async (credentialId, window) =>
    Number((await valkey('HGET', `dirouter:quota:${credentialId}:${window}`, 'requests')) || 0);

  await scenario(
    '32.6 fill-first uses one credential up to its quota window, then the next, without an error',
    async () => {
      const { provider, seats, model } = await plan('fill');
      const [one, two] = seats;
      await published(() =>
        org('PUT', `providers/${provider.id}/spend`, { credentialStrategy: 'fill-first' }, 200),
      );
      await published(() =>
        org(
          'PUT',
          `providers/${provider.id}/credentials/${one}/spend`,
          { quotaWindows: [{ id: '5h', hours: 5, limitRequests: 3 }] },
          200,
        ),
      );
      await published(() =>
        org(
          'PUT',
          `providers/${provider.id}/credentials/${two}/spend`,
          { quotaWindows: [{ id: '5h', hours: 5, limitRequests: 1000 }] },
          200,
        ),
      );
      const key = await createKey('fill-first');
      const served = [];
      for (let i = 0; i < 5; i++) {
        const before = [await used(one, '5h'), await used(two, '5h')];
        const res = await ask(key.key, model);
        assert.equal(res.response.status, 200, res.text);
        const after = await waitFor('the quota counter to move', async () => {
          const now = [await used(one, '5h'), await used(two, '5h')];
          return now[0] + now[1] > before[0] + before[1] ? now : undefined;
        });
        served.push(after[0] > before[0] ? 'seat-1' : 'seat-2');
      }
      assert.deepEqual(served, ['seat-1', 'seat-1', 'seat-1', 'seat-2', 'seat-2']);

      // The Health page countdown: the window started with the first request and lasts 5 hours.
      const health = (await org('GET', 'health/runtime')).body;
      const quotas = health.providers
        .find((p) => p.id === provider.id)
        .credentials.find((c) => c.id === one).quotas;
      const window = quotas.find((q) => q.id === '5h');
      assert.equal(window.exhausted, true);
      assert.equal(window.used.requests, 3);
      const left = Date.parse(window.resetAt) - Date.now();
      assert.ok(left > 5 * 3_600_000 - 5 * 60_000 && left <= 5 * 3_600_000, String(left));
    },
  );

  await scenario(
    '32.6 a credential at its daily budget hands the traffic to the next one without an error',
    async () => {
      const { provider, seats, model } = await plan('budget');
      const [one, two] = seats;
      await published(() =>
        org('PUT', `providers/${provider.id}/spend`, { credentialStrategy: 'fill-first' }, 200),
      );
      // Large windows only count which credential answered.
      for (const seat of seats)
        await published(() =>
          org(
            'PUT',
            `providers/${provider.id}/credentials/${seat}/spend`,
            {
              quotaWindows: [{ id: 'count', hours: 1, limitRequests: 100_000 }],
              ...(seat === one
                ? { budgets: [{ period: 'daily', limitUsd: '0.00000001', alertThresholds: [100] }] }
                : {}),
            },
            200,
          ),
        );
      const key = await createKey('credential-budget');
      // The first request is served by seat-1 and uses up its budget; the rest move to seat-2.
      for (let i = 0; i < 4; i++) {
        const res = await ask(key.key, model);
        assert.equal(res.response.status, 200, res.text);
        // The counters are written after the response; let them land before the next request.
        await waitFor('the request to be counted', async () =>
          (await used(one, 'count')) + (await used(two, 'count')) > i ? true : undefined,
        );
      }
      await waitFor('seat-2 to take the traffic', async () =>
        (await used(two, 'count')) >= 2 ? true : undefined,
      );
      assert.equal(await used(one, 'count'), 1);

      // A budget on the whole provider takes its model out of the route.
      await published(() =>
        org(
          'PUT',
          `providers/${provider.id}/spend`,
          { budgets: [{ period: 'monthly', limitUsd: '0.00000001', alertThresholds: [100] }] },
          200,
        ),
      );
      const refused = await waitFor('the provider budget to refuse the model', async () => {
        const res = await ask(key.key, model);
        return res.response.status === 429 ? res : undefined;
      });
      assert.match(
        refused.body.error.message,
        /Monthly provider account budget exceeded for every target/,
      );
    },
  );
}
