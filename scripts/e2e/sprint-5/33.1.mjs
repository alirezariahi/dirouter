/**
 * Card 33.1: organization, member, model and provider scopes, and weekly and yearly budgets,
 * through Traefik on the dev stack. Each scenario removes its limits again; while the organization
 * budget scenario runs, every key of org_dev is refused for a few seconds.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, waitFor } from '../harness.mjs';

const ask = (key, model) =>
  chat(key, { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 });

export async function register({ scenario, cleanups, api, org, ORG, createKey }) {
  /**
   * Sets the limits of a scope for the duration of `run` only: these scopes cover every key the
   * scenarios create, so a leftover would break the scenarios after it.
   */
  async function withLimit(scope, id, body, run) {
    const remove = () => published(() => org('DELETE', `limits/${scope}/${id}`, undefined, null));
    cleanups.push(remove);
    const set = await published(() => org('PUT', `limits/${scope}/${id}`, body, 200));
    try {
      return await run(set.body);
    } finally {
      cleanups.splice(cleanups.indexOf(remove), 1);
      await remove();
    }
  }
  const tiny = (period) => ({
    budgets: [{ period, limitUsd: '0.00000001', alertThresholds: [100] }],
  });

  await scenario(
    '33.1 a monthly organization budget stops every key of the organization; removing it lets them through',
    async () => {
      const first = await createKey('org-budget-a');
      const second = await createKey('org-budget-b');
      await withLimit('organization', ORG, tiny('monthly'), async (set) => {
        assert.equal(set.scope, 'organization');
        // The organization has spent something this month already, or does after one request.
        const refused = await waitFor('the organization budget to stop the key', async () => {
          const res = await ask(first.key, 'mock/small');
          return res.response.status === 429 ? res : undefined;
        });
        assert.equal(refused.body.error.code, 'budget_exceeded');
        assert.match(refused.body.error.message, /Monthly organization budget exceeded/);
        const sibling = await ask(second.key, 'mock/small');
        assert.equal(sibling.response.status, 429, 'another key of the organization is stopped');
      });
      assert.equal((await ask(second.key, 'mock/small')).response.status, 200);
    },
  );

  await scenario(
    "33.1 a weekly member budget stops the keys that member created, and usage reports the member's week",
    async () => {
      const me = (await api('GET', 'auth/me')).body;
      const key = await createKey('member-budget');
      await withLimit('user', me.id, tiny('weekly'), async () => {
        const refused = await waitFor('the member budget to stop the key', async () => {
          const res = await ask(key.key, 'mock/small');
          return res.response.status === 429 ? res : undefined;
        });
        assert.match(refused.body.error.message, /Weekly user budget exceeded/);
        assert.ok(Number(refused.response.headers.get('retry-after')) <= 7 * 86_400);
        const usage = (await org('GET', 'limits/usage')).body;
        const mine = usage.scopes.find((s) => s.scope === 'user' && s.scopeId === me.id);
        assert.ok(mine, 'the member is listed in usage');
        assert.equal(mine.budgets[0].period, 'weekly');
        assert.ok(Number(mine.week.usd) > 0, JSON.stringify(mine));
      });
    },
  );

  await scenario(
    '33.1 a used-up model budget takes the model out of a combo and refuses the model itself',
    async () => {
      const models = (await org('GET', 'models')).body;
      const id = (slug) => {
        const found = models.find((m) => m.slug === slug);
        assert.ok(found, `model ${slug} is seeded`);
        return found.id;
      };
      const combo = (
        await published(() =>
          org(
            'POST',
            'combos',
            {
              slug: `s5-scope-${randomUUID().slice(0, 6)}`,
              strategy: 'priority',
              targets: [{ modelId: id('mock/long') }, { modelId: id('mock/small') }],
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `combos/${combo.id}`, undefined, null));
      const key = await createKey('model-budget');
      await withLimit('model', id('mock/long'), tiny('yearly'), async () => {
        const served = await waitFor('the combo to move to its next target', async () => {
          const res = await ask(key.key, combo.slug);
          assert.equal(res.response.status, 200, res.text);
          return res.response.headers.get('x-dirouter-model') === 'mock/small' ? res : undefined;
        });
        assert.equal(served.response.status, 200);
        const direct = await ask(key.key, 'mock/long');
        assert.equal(direct.response.status, 429);
        assert.match(
          direct.body.error.message,
          /Yearly model budget exceeded for every target of 'mock\/long'/,
        );
      });
    },
  );

  await scenario('33.1 a provider rate limit counts every key of the organization', async () => {
    const providers = (await org('GET', 'providers')).body;
    const provider = providers.find((p) => p.slug === 'mock-long' || p.id === 'prv_mock-long');
    assert.ok(provider, 'provider mock-long is seeded');
    const a = await createKey('provider-rpm-a');
    const b = await createKey('provider-rpm-b');
    await withLimit('provider', provider.id, { rpm: 1, budgets: [] }, async () => {
      const statuses = [];
      statuses.push((await ask(a.key, 'mock/long')).response.status);
      const second = await ask(b.key, 'mock/long');
      statuses.push(second.response.status);
      assert.deepEqual(statuses, [200, 429]);
      assert.match(second.body.error.message, /Rate limit exceeded for provider \(requests\)/);
      assert.equal((await ask(b.key, 'mock/small')).response.status, 200);
    });
  });
}
