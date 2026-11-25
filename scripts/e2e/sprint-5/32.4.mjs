/**
 * Card 32.4: shadow traffic through Traefik. A slow and a failing shadow model change nothing in
 * the client's answer or its latency; the shadow cost is stored apart (shadow_requests), never in
 * the request log, the ledger or the key's budget, the daily cap stops it, and the report compares
 * shadow and primary.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, sql, valkey, waitFor } from '../harness.mjs';

export function register({ scenario, cleanups, org, createKey }) {
  const suffix = randomUUID().slice(0, 6);
  const shadowModel = async (name, secret) => {
    const provider = (
      await org(
        'POST',
        'providers',
        {
          name: `s5-shadow-${name}-${suffix}`,
          slug: `s5-shadow-${name}-${suffix}`,
          type: 'openai-compatible',
          baseUrl: 'http://mock-provider:8090/v1',
          credentials: [{ name: 'k', secret }],
        },
        201,
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
            slug: `s5/shadow-${name}-${suffix}`,
            pricing: { inputPerMTok: '50', outputPerMTok: '50' },
          },
          201,
        ),
      )
    ).body;
    cleanups.push(() => org('DELETE', `models/${model.id}`, undefined, null));
    return model;
  };
  const shadowPolicy = async (body) => {
    const created = (await published(() => org('POST', 'routing/shadows', body, 201))).body;
    cleanups.push(() => org('DELETE', `routing/shadows/${created.id}`, undefined, null));
    return created;
  };
  const ask = (key, model) =>
    chat(key, { model, max_tokens: 8, messages: [{ role: 'user', content: 'shadow me' }] });

  scenario(
    '32.4 a slow and a failing shadow model have no effect on the answer or its latency; the shadow cost is stored apart and not taken from the key budget',
    async () => {
      const slow = await shadowModel('slow', 'mock:latency=2500');
      const broken = await shadowModel('broken', 'mock:status=500');
      const key = await createKey('shadow', {
        budgets: [{ period: 'daily', limitUsd: '100' }],
      });
      // Baseline without a shadow policy.
      const baseline = [];
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        assert.equal((await ask(key.key, 'mock/small')).response.status, 200);
        baseline.push(Date.now() - t0);
      }
      const slowPolicy = await shadowPolicy({
        name: `s5 slow ${suffix}`,
        match: 'mock/small',
        target: slow.slug,
        sampleRate: 1,
        dailyBudgetUsd: '10',
      });
      const brokenPolicy = await shadowPolicy({
        name: `s5 broken ${suffix}`,
        match: 'mock/nousage',
        target: broken.slug,
        sampleRate: 1,
        dailyBudgetUsd: '10',
      });
      const timed = [];
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const res = await ask(key.key, 'mock/small');
        timed.push(Date.now() - t0);
        assert.equal(res.response.status, 200, res.text);
        assert.equal(res.response.headers.get('x-dirouter-model'), 'mock/small');
        assert.equal(res.body.model, 'mock/small');
        ids.push(res.response.headers.get('x-request-id'));
      }
      // The shadow model answers after 2.5 s; every client answer came well before that.
      assert.ok(Math.max(...timed) < 2_000, `latencies ${timed.join(',')}`);
      const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      assert.ok(median(timed) < median(baseline) + 300, `${median(timed)} vs ${median(baseline)}`);
      const failing = await ask(key.key, 'mock/nousage');
      assert.equal(failing.response.status, 200, failing.text);

      // The worker stores the copies apart from the request log and the ledger.
      const rows = await waitFor(
        'the shadow copies',
        async () => {
          const out = await sql(
            `SELECT policy_id || '|' || status || '|' || cost_usd || '|' || latency_ms FROM shadow_requests WHERE policy_id IN ('${slowPolicy.id}', '${brokenPolicy.id}')`,
          );
          const lines = out ? out.split('\n') : [];
          return lines.length >= 6 ? lines : undefined;
        },
        60_000,
      );
      const slowRows = rows.filter((r) => r.startsWith(slowPolicy.id));
      assert.ok(
        slowRows.every((r) => r.split('|')[1] === 'success' && Number(r.split('|')[3]) >= 2_400),
      );
      assert.ok(rows.some((r) => r.startsWith(`${brokenPolicy.id}|error`)));
      assert.equal(await sql(`SELECT count(*) FROM request_log WHERE id LIKE '%:shadow'`), '0');
      assert.equal(
        await sql(`SELECT count(*) FROM usage_ledger WHERE request_id LIKE '%:shadow%'`),
        '0',
      );
      // The key's budget counter holds the client's requests only.
      await waitFor(
        'the client requests in the ledger',
        async () =>
          Number(await sql(`SELECT count(*) FROM usage_ledger WHERE api_key_id = '${key.id}'`)) >=
          11,
      );
      const ledger = Number(
        await sql(
          `SELECT coalesce(sum(cost_usd), 0) FROM usage_ledger WHERE api_key_id = '${key.id}'`,
        ),
      );
      const budgetId = await sql(
        `SELECT id FROM budgets WHERE scope = 'API_KEY' AND scope_id = '${key.id}'`,
      );
      const counter = Number(
        (await valkey(
          'HGET',
          `dirouter:budget:${budgetId}:d:${new Date().toISOString().slice(0, 10)}`,
          'usd',
        )) || 0,
      );
      assert.ok(
        Math.abs(counter / 1e8 - ledger) < 1e-7,
        `budget ${counter / 1e8} vs ledger ${ledger}`,
      );

      const report = await waitFor('the shadow report', async () => {
        const body = (await org('GET', `routing/shadows/${slowPolicy.id}/report`, undefined, 200))
          .body;
        return body.requests >= 5 ? body : undefined;
      });
      assert.ok(report.shadow.avgLatencyMs >= 2_400);
      assert.ok(report.primary.avgLatencyMs < 2_000);
      assert.ok(Number(report.shadow.costUsd) > 0);
      assert.ok(Number(report.today.spentUsd) > 0);
      assert.ok(ids.every(Boolean));
    },
  );

  scenario('32.4 the shadow stops for the day at its own cost cap', async () => {
    const key = await createKey('shadow-cap');
    const target = await sql(`SELECT slug FROM models WHERE id = 'mdl_dev_mock_small'`);
    const capped = await shadowPolicy({
      name: `s5 cap ${suffix}`,
      match: 'mock/claude',
      target,
      sampleRate: 1,
      dailyBudgetUsd: '0.00000001',
    });
    for (let i = 0; i < 4; i++)
      assert.equal((await ask(key.key, 'mock/claude')).response.status, 200);
    await waitFor(
      'one shadow copy',
      async () =>
        (await sql(`SELECT count(*) FROM shadow_requests WHERE policy_id = '${capped.id}'`)) ===
        '1',
    );
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(
      await sql(`SELECT count(*) FROM shadow_requests WHERE policy_id = '${capped.id}'`),
      '1',
    );
    const report = (await org('GET', `routing/shadows/${capped.id}/report`, undefined, 200)).body;
    assert.equal(report.today.capped, true);
  });
}
