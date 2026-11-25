/**
 * Card 33.2: end users with budgets, limits and blocking, and their usage in analytics, through
 * Traefik on the dev stack. The end-user defaults are removed again at the end of the scenario.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, waitFor } from '../harness.mjs';

const ask = (key, endUser, viaHeader = false) =>
  chat(
    key,
    {
      model: 'mock/small',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
      ...(viaHeader ? {} : { user: endUser }),
    },
    viaHeader ? { 'x-dirouter-end-user': endUser } : {},
  );

export async function register({ scenario, cleanups, org, createKey }) {
  const run = randomUUID().slice(0, 8);

  await scenario(
    '33.2 an end user with a used-up budget gets 429 while other end users keep working',
    async () => {
      const key = await createKey('end-user-budget');
      const remove = () => published(() => org('DELETE', 'limits/end_user/*', undefined, null));
      cleanups.push(remove);
      await published(() =>
        org(
          'PUT',
          'limits/end_user/*',
          { budgets: [{ period: 'daily', limitUsd: '0.00000001', alertThresholds: [100] }] },
          200,
        ),
      );
      try {
        const alice = `e2e-${run}-alice`;
        const bob = `e2e-${run}-bob`;
        // The first request of an end user still passes (nothing spent yet); then its own
        // counter is over the cap.
        assert.equal((await ask(key.key, alice)).response.status, 200);
        const refused = await waitFor('the end-user budget to stop alice', async () => {
          const res = await ask(key.key, alice, true);
          return res.response.status === 429 ? res : undefined;
        });
        assert.equal(refused.body.error.code, 'budget_exceeded');
        assert.match(refused.body.error.message, /Daily end user budget exceeded/);
        assert.equal((await ask(key.key, bob)).response.status, 200, 'another end user passes');
        const anonymous = await chat(key.key, {
          model: 'mock/small',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 8,
        });
        assert.equal(anonymous.response.status, 200, 'a request without an end user passes');
      } finally {
        cleanups.splice(cleanups.indexOf(remove), 1);
        await remove();
      }
    },
  );

  await scenario('33.2 a blocked end user gets 403 until it is unblocked', async () => {
    const key = await createKey('end-user-block');
    const mallory = `e2e-${run}-mallory`;
    const path = `end-users/${encodeURIComponent(mallory)}`;
    const unblock = () => published(() => org('PUT', path, { blocked: false }, null));
    cleanups.push(unblock);
    await published(() => org('PUT', path, { blocked: true }, 200));
    const refused = await ask(key.key, mallory);
    assert.equal(refused.response.status, 403);
    assert.equal(refused.body.error.code, 'end_user_blocked');
    assert.equal((await ask(key.key, mallory, true)).response.status, 403);
    await unblock();
    cleanups.splice(cleanups.indexOf(unblock), 1);
    assert.equal((await ask(key.key, mallory)).response.status, 200);
  });

  await scenario("33.2 the end-user list and analytics show each end user's usage", async () => {
    const key = await createKey('end-user-usage');
    const carol = `e2e-${run}-carol`;
    const dave = `e2e-${run}-dave`;
    for (const endUser of [carol, carol, dave])
      assert.equal((await ask(key.key, endUser)).response.status, 200);
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const usage = await waitFor(
      'the rollup to count the end users',
      async () => {
        const { body } = await org(
          'GET',
          `stats/dimensions?dimension=end_user&limit=1000&from=${from}`,
        );
        const c = body.items.find((i) => i.id === carol);
        const d = body.items.find((i) => i.id === dave);
        return c?.requests >= 2 && d?.requests >= 1 ? { c, d } : undefined;
      },
      120_000,
    );
    assert.ok(Number(usage.c.costUsd) > 0);
    const list = (await org('GET', `end-users?search=${encodeURIComponent(carol)}`)).body;
    assert.equal(list.items[0]?.id, carol);
    assert.ok(list.items[0].lastSeenAt);
    const detail = (await org('GET', `end-users/${encodeURIComponent(carol)}`)).body;
    assert.ok(
      detail.days.some((d) => d.requests >= 2),
      JSON.stringify(detail.days),
    );
    const analytics = (await org('GET', `stats/analytics?from=${from}`)).body;
    assert.ok(Array.isArray(analytics.byEndUser.items));
  });
}
