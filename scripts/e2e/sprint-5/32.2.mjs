/**
 * Card 32.2: conditional routing rules through Traefik. A header rule reroutes, a rule on the
 * team budget sends an over-budget team to the cheap model, an invalid condition is refused at
 * save time, the simulator shows the matched rule and the traffic report counts it.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { chat, published, valkey, waitFor } from '../harness.mjs';

const BUDGET_UNITS_PER_USD = 100_000_000;
const monthKey = () => `m:${new Date().toISOString().slice(0, 7)}`;

export async function register({ scenario, cleanups, org }) {
  const suffix = randomUUID().slice(0, 6);
  const rule = async (body) => {
    const created = (await published(() => org('POST', 'routing/rules', body, 201))).body;
    cleanups.push(() => org('DELETE', `routing/rules/${created.id}`, undefined, null));
    return created;
  };
  const ask = (key, headers = {}) =>
    chat(
      key,
      { model: 'mock/small', max_tokens: 8, messages: [{ role: 'user', content: 'route me' }] },
      headers,
    );

  await scenario('32.2 an invalid condition is refused when the rule is saved', async () => {
    for (const condition of ['budget.team >', 'request.nope == 1', 'request.model == 3']) {
      const res = await org(
        'POST',
        'routing/rules',
        { name: 'bad', condition, action: { type: 'route', target: 'mock/small' } },
        400,
      );
      assert.match(res.text, /condition/);
    }
    const check = await org('POST', 'routing/rules/validate', { condition: 'nope' }, 200);
    assert.equal(check.body.valid, false);
  });

  await scenario(
    '32.2 a team over 80% of its budget is routed to the cheap model; a header rule reroutes; the simulator and traffic report show the rules',
    async () => {
      const team = (await org('POST', 'teams', { name: `S5 rules ${suffix}` }, 201)).body;
      cleanups.push(() => org('DELETE', `teams/${team.id}`, undefined, null));
      const project = (
        await org(
          'POST',
          'projects',
          { name: `S5 rules ${suffix}`, slug: `s5-rules-${suffix}`, teamId: team.id },
          201,
        )
      ).body;
      cleanups.push(() => org('DELETE', `projects/${project.id}`, undefined, null));
      const limit = (
        await published(() =>
          org(
            'PUT',
            `limits/team/${team.id}`,
            { budgets: [{ period: 'monthly', limitUsd: '100', alertThresholds: [100] }] },
            200,
          ),
        )
      ).body;
      cleanups.push(() => org('DELETE', `limits/team/${team.id}`, undefined, null));
      const budgetId = limit.budgets[0].id;
      const key = (
        await published(() =>
          org('POST', 'keys', { name: `s5-rules-${suffix}`, projectId: project.id }, 201),
        )
      ).body;
      cleanups.push(() => org('POST', `keys/${key.id}/revoke`, undefined, null));

      const header = await rule({
        name: `s5 gold ${suffix}`,
        priority: 1,
        condition: `request.headers['x-s5-tier'] == 'gold-${suffix}'`,
        action: { type: 'route', target: 'mock/claude' },
      });
      const budget = await rule({
        name: `s5 budget ${suffix}`,
        priority: 2,
        teamId: team.id,
        condition: 'budget.team > 80',
        action: { type: 'route', target: 'mock/nousage' },
      });

      // Under the threshold the request goes where the client asked.
      const counter = `dirouter:budget:${budgetId}:${monthKey()}`;
      await valkey('HSET', counter, 'usd', String(50 * BUDGET_UNITS_PER_USD), 'tokens', '0');
      cleanups.push(() => valkey('DEL', counter));
      const under = await waitFor('the key to work', async () => {
        const res = await ask(key.key);
        return res.response.status === 200 ? res : undefined;
      });
      assert.equal(under.response.headers.get('x-dirouter-model'), 'mock/small');

      // Over 80% of the team budget: the cheap model (the share is cached for a second).
      await valkey('HSET', counter, 'usd', String(81 * BUDGET_UNITS_PER_USD));
      const over = await waitFor('the budget rule to fire', async () => {
        const res = await ask(key.key);
        return res.response.headers.get('x-dirouter-model') === 'mock/nousage' ? res : undefined;
      });
      assert.equal(over.response.status, 200);
      assert.equal(over.response.headers.get('x-dirouter-rule'), budget.id);
      assert.equal(over.body.model, 'mock/small', 'the client still sees the name it asked for');

      // A header rule, for any key of the organization.
      const gold = await ask(key.key, { 'x-s5-tier': `gold-${suffix}` });
      assert.equal(gold.response.status, 200, gold.text);
      assert.equal(gold.response.headers.get('x-dirouter-model'), 'mock/claude');
      assert.equal(gold.response.headers.get('x-dirouter-rule'), header.id);

      // The simulator evaluates the same rules from described inputs.
      const sim = await org(
        'POST',
        'routes/simulate',
        { model: 'mock/small', virtualKeyId: key.id, budget: { team: 90 } },
        200,
      );
      assert.equal(sim.body.rules.decidedBy, budget.id);
      assert.equal(sim.body.rules.target, 'mock/nousage');

      // The traffic report counts each rule once the worker wrote the request log.
      const traffic = await waitFor('the rule traffic report', async () => {
        const body = (await org('GET', 'routing/rules/traffic', undefined, 200)).body;
        const b = body.rules.find((r) => r.id === budget.id);
        const h = body.rules.find((r) => r.id === header.id);
        return b?.decided >= 1 && h?.decided >= 1 ? body : undefined;
      });
      assert.ok(traffic.totalRequests >= 3);
      assert.ok(traffic.rules.every((r) => r.share >= 0 && r.share <= 1));
    },
  );
}
