/** Conditional routing rules on the request path (card 32.2). */
import { randomUUID } from 'node:crypto';

import { budgetCounterKey, budgetPeriodKey, usdToUnits } from '@dirouter/contracts';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INTERNAL_TOKEN, KEYS, policyGateway, type PolicyGateway } from './testing/policy-kit.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

const rule = (
  id: string,
  priority: number,
  condition: string,
  action: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({ id, organizationId: 'org', name: id, priority, condition, action, ...extra }) as never;

describe('routing rules', () => {
  let env: PolicyGateway;

  beforeAll(async () => {
    env = await policyGateway({
      routingRules: [
        rule('rr-tag', 1, "request.metadata.feature == 'search'", {
          type: 'tag',
          tags: { feature: 'search' },
        }),
        rule('rr-gold', 2, "request.headers['x-tier'] == 'gold'", {
          type: 'route',
          target: 'big',
        }),
        rule('rr-block', 3, "request.headers['x-tier'] == 'blocked'", {
          type: 'reject',
          message: 'this tier is closed',
          status: 403,
        }),
        rule(
          'rr-team-b',
          4,
          'request.estimated_tokens > 0',
          { type: 'route', target: 'mid' },
          {
            teamId: 'team-b',
          },
        ),
        rule('rr-cheapest', 5, "request.headers['x-tier'] == 'cheapest'", {
          type: 'route',
          target: 'cheap',
        }),
      ],
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it('routes by header, records the rule and keeps the client-facing name', async () => {
    const res = await env.chat(KEYS.teamA, 'cheap', { headers: { 'x-tier': 'gold' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-model')).toBe('big');
    expect(res.headers.get('x-dirouter-rule')).toBe('rr-gold');
    expect(res.body.model).toBe('cheap');
    expect(env.usage.at(-1)).toMatchObject({
      requestedModel: 'cheap',
      resolvedModelId: 'org-big',
      policy: { rules: { matched: ['rr-gold'], decidedBy: 'rr-gold', target: 'big' } },
    });
  });

  it('tags by metadata and goes on to the requested model', async () => {
    const res = await env.chat(KEYS.teamA, 'cheap', { body: { metadata: { feature: 'search' } } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-model')).toBe('cheap');
    expect(env.usage.at(-1)?.policy).toEqual({
      rules: { matched: ['rr-tag'], tags: { feature: 'search' } },
    });
  });

  it('rejects with the rule message and never reaches a provider', async () => {
    const before = env.usage.length;
    const res = await env.chat(KEYS.teamA, 'cheap', { headers: { 'x-tier': 'blocked' } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('this tier is closed');
    expect(env.usage.length).toBe(before);
  });

  it("applies a team's own policy only to that team", async () => {
    const b = await env.chat(KEYS.teamB, 'cheap');
    expect(b.headers.get('x-dirouter-model')).toBe('mid');
    const a = await env.chat(KEYS.teamA, 'cheap');
    expect(a.headers.get('x-dirouter-model')).toBe('cheap');
    expect(env.usage.at(-1)?.policy).toBeUndefined();
  });

  it("never applies another organization's rules", async () => {
    const res = await env.chat(KEYS.other, 'big', { headers: { 'x-tier': 'blocked' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-model')).toBe('big');
    expect(env.usage.at(-1)?.resolvedModelId).toBe('org-2-big');
  });

  it('does not let a rule widen a key allow-list: the name the client sent is checked first', async () => {
    const denied = await env.chat(KEYS.allowed, 'cheap', { headers: { 'x-tier': 'gold' } });
    expect(denied.status).toBe(403);
    // An allowed name may still be sent elsewhere by the organization's rule.
    const allowed = await env.chat(KEYS.allowed, 'big', { headers: { 'x-tier': 'blocked' } });
    expect(allowed.status).toBe(403);
    expect(JSON.stringify(allowed.body)).toContain('this tier is closed');
  });

  it("keeps the client's fallback models inside the key allow-list when a rule picked the target", async () => {
    // The key may only use `big`; the rule sends it to `cheap`, which the client then excludes
    // so that only its own fallback could answer.
    const res = await env.chat(KEYS.allowed, 'big', {
      headers: { 'x-tier': 'cheapest' },
      body: { models: ['shadow-slow'], provider: { ignore: ['p'] } },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('x-dirouter-model')).toBeNull();
    // Without the exclusion the rule's target answers.
    const ok = await env.chat(KEYS.allowed, 'big', {
      headers: { 'x-tier': 'cheapest' },
      body: { models: ['shadow-slow'] },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-dirouter-model')).toBe('cheap');
  });

  it('shows the matched rule in the routing simulator', async () => {
    const res = await fetch(`${env.base}/internal/routes/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_TOKEN}` },
      body: JSON.stringify({
        model: 'cheap',
        organizationId: 'org',
        headers: { 'X-Tier': 'gold' },
        metadata: { feature: 'search' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      requested: 'cheap',
      resolvedName: 'big',
      rules: {
        matched: [
          { id: 'rr-tag', name: 'rr-tag' },
          { id: 'rr-gold', name: 'rr-gold' },
        ],
        decidedBy: 'rr-gold',
        target: 'big',
        tags: { feature: 'search' },
      },
    });
    const rejected = await fetch(`${env.base}/internal/routes/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${INTERNAL_TOKEN}` },
      body: JSON.stringify({
        model: 'cheap',
        organizationId: 'org',
        headers: { 'x-tier': 'blocked' },
      }),
    });
    expect(rejected.status).toBe(403);
  });
});

describe.skipIf(!VALKEY_URL)('a rule on the team budget', () => {
  const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
  const budgetId = `bud-rule-${randomUUID()}`;
  let env: PolicyGateway;

  beforeAll(async () => {
    if (redis.status !== 'ready') await new Promise((ready) => redis.once('ready', ready));
    env = await policyGateway(
      {
        routingRules: [
          rule('rr-budget', 1, 'budget.team > 80', { type: 'route', target: 'cheap' }),
        ],
      },
      { redis, budgetId },
    );
  });
  afterAll(async () => {
    await env.close();
    redis.disconnect();
  });

  it('sends a team over 80% of its budget to the cheap model', async () => {
    const counter = budgetCounterKey(budgetId, budgetPeriodKey('monthly'));
    await redis.hset(counter, 'usd', String(usdToUnits('50')), 'tokens', '0');
    const under = await env.chat(KEYS.teamA, 'big');
    expect(under.status).toBe(200);
    expect(under.headers.get('x-dirouter-model')).toBe('big');
    // The share is cached for a second; past that the next request sees the new spend.
    await redis.hset(counter, 'usd', String(usdToUnits('81')));
    await new Promise((r) => setTimeout(r, 1_100));
    const over = await env.chat(KEYS.teamA, 'big');
    expect(over.status).toBe(200);
    expect(over.headers.get('x-dirouter-model')).toBe('cheap');
    expect(env.usage.at(-1)?.policy?.rules).toMatchObject({ decidedBy: 'rr-budget' });
    // Team B has no budget: its spend reads 0 and the rule does not fire.
    const other = await env.chat(KEYS.teamB, 'big');
    expect(other.headers.get('x-dirouter-model')).toBe('big');
    await redis.del(counter);
  });
});
