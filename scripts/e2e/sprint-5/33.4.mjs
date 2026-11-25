/**
 * Card 33.4: tags and cost centers through Traefik on the dev stack: cost by tag in analytics and
 * its CSV source, and a tag budget that stops only the requests carrying the tag. Tag names are
 * unique to the run, and the tag limit is removed at the end.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, waitFor } from '../harness.mjs';

const ask = (key, headers = {}) =>
  chat(
    key,
    { model: 'mock/small', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 },
    headers,
  );

export async function register({ scenario, cleanups, org, createKey }) {
  const run = randomUUID().slice(0, 8);
  const feature = `e2e-feature-${run}`;
  const cc = `e2e-cc-${run}`;

  await scenario(
    '33.4 cost by tag and cost center shows in analytics and its CSV source',
    async () => {
      const key = await createKey('tags', { tags: [`e2e-team-${run}`], costCenter: cc });
      assert.deepEqual(key.tags, [`e2e-team-${run}`]);
      for (let i = 0; i < 2; i++)
        assert.equal((await ask(key.key, { 'x-dirouter-tags': feature })).response.status, 200);
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const byTag = await waitFor(
        'the rollup to count the tags',
        async () => {
          const { body } = await org(
            'GET',
            `stats/dimensions?dimension=tag&limit=1000&from=${from}`,
          );
          const f = body.items.find((i) => i.id === feature);
          const team = body.items.find((i) => i.id === `e2e-team-${run}`);
          return f?.requests >= 2 && team?.requests >= 2 ? { f, team } : undefined;
        },
        120_000,
      );
      assert.ok(Number(byTag.f.costUsd) > 0);
      const byModel = (
        await org(
          'GET',
          `stats/dimensions?dimension=tag&value=${encodeURIComponent(feature)}&groupBy=model&from=${from}`,
        )
      ).body;
      assert.equal(byModel.items[0]?.id, 'mock/small');
      const byCc = (await org('GET', `stats/dimensions?dimension=cost_center&from=${from}`)).body;
      assert.ok(byCc.items.some((i) => i.id === cc && i.requests >= 2));
      const analytics = (await org('GET', `stats/analytics?from=${from}`)).body;
      assert.ok(
        Array.isArray(analytics.byTag.items) && Array.isArray(analytics.byCostCenter.items),
      );
    },
  );

  await scenario("33.4 a tag's budget stops the requests carrying that tag", async () => {
    const key = await createKey('tag-budget');
    const path = `limits/tag/${encodeURIComponent(feature)}`;
    const remove = () => published(() => org('DELETE', path, undefined, null));
    cleanups.push(remove);
    await published(() =>
      org(
        'PUT',
        path,
        { budgets: [{ period: 'daily', limitUsd: '0.00000001', alertThresholds: [100] }] },
        200,
      ),
    );
    try {
      const refused = await waitFor('the tag budget to stop the key', async () => {
        const res = await ask(key.key, { 'x-dirouter-tags': feature });
        return res.response.status === 429 ? res : undefined;
      });
      assert.match(refused.body.error.message, /Daily tag budget exceeded/);
      assert.equal(
        (await ask(key.key, { 'x-dirouter-tags': `other-${run}` })).response.status,
        200,
      );
      assert.equal((await ask(key.key)).response.status, 200);
    } finally {
      cleanups.splice(cleanups.indexOf(remove), 1);
      await remove();
    }
  });
}
