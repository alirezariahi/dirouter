/**
 * Card 32.9: upstream balance lookup. Three providers (OpenRouter, DeepSeek and Moonshot presets)
 * point at the mock provider's balance APIs; their balances reach the Providers page data, and an
 * `upstream_balance_low` rule delivers to a webhook channel (the mock's /__hooks sink).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { published, request, urls, waitFor } from '../harness.mjs';

const setMockBalance = (amount) =>
  request(
    `${urls.mock}/__mock/balance`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount }),
    },
    200,
  );

export async function register({ scenario, cleanups, org }) {
  const tag = randomUUID().slice(0, 6);
  const providers = [];

  async function setup() {
    if (providers.length > 0) return;
    await setMockBalance(42.5);
    cleanups.push(() => setMockBalance(42.5));
    for (const preset of ['openrouter', 'deepseek', 'moonshot']) {
      const created = (
        await published(() =>
          org(
            'POST',
            'providers',
            {
              name: `s5 balance ${preset} ${tag}`,
              slug: `s5-bal-${preset}-${tag}`,
              type: 'openai-compatible',
              baseUrl: 'http://mock-provider:8090/v1',
              options: { preset },
              credentials: [{ name: 'main', secret: `mock-e2e-balance-${tag}`, weight: 1 }],
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `providers/${created.id}`, undefined, null));
      assert.equal(created.balanceKind, preset);
      providers.push(created);
    }
  }

  await scenario('32.9 the balance of three providers is shown on the Providers page', async () => {
    await setup();
    for (const provider of providers) {
      const refreshed = (await org('POST', `providers/${provider.id}/balance`)).body;
      assert.equal(refreshed.credentials[0].balance.ok, true, JSON.stringify(refreshed));
    }
    const listed = (await org('GET', 'providers')).body;
    for (const provider of providers) {
      const balance = listed.find((p) => p.id === provider.id).credentials[0].balance;
      assert.equal(balance.amount, '42.5');
      assert.equal(balance.currency, 'USD');
      assert.ok(Date.parse(balance.checkedAt) > Date.now() - 120_000);
    }
  });

  await scenario('32.9 a low upstream balance alert reaches the channel', async () => {
    await setup();
    await setMockBalance(0.5);
    const low = (await org('POST', `providers/${providers[0].id}/balance`)).body;
    assert.equal(low.credentials[0].balance.amount, '0.5');

    const hook = `s5-balance-${tag}`;
    const channel = (
      await org(
        'POST',
        'alerts/channels',
        {
          name: `s5-balance-${tag}`,
          type: 'webhook',
          config: { url: `http://mock-provider:8090/__hooks/${hook}` },
        },
        201,
      )
    ).body;
    cleanups.push(() => org('DELETE', `alerts/channels/${channel.id}`, undefined, null));
    const rule = (
      await org(
        'POST',
        'alerts/rules',
        {
          name: `s5-low-balance-${tag}`,
          type: 'upstream_balance_low',
          threshold: 1,
          windowMinutes: 60,
          silenceMinutes: 60,
          channelId: channel.id,
        },
        201,
      )
    ).body;
    cleanups.push(() => org('DELETE', `alerts/rules/${rule.id}`, undefined, null));

    const delivered = await waitFor(
      'the low-balance alert at the webhook',
      async () => {
        const { body } = await request(`${urls.mock}/__hooks/${hook}`, {}, 200);
        return body
          .map((h) => JSON.parse(h.body))
          .find((b) => JSON.stringify(b).includes(rule.name));
      },
      120_000,
    );
    assert.match(JSON.stringify(delivered), /balance 0\.5/);
  });
}
