/** Controls of automatic routing on the request path (card 32.8). */
import type { AutoRoutingPolicyConfig } from '@dirouter/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KEYS, policyGateway, type PolicyGateway } from './testing/policy-kit.js';

const policy = (over: Partial<AutoRoutingPolicyConfig>): AutoRoutingPolicyConfig => ({
  organizationId: 'org',
  scope: 'organization',
  scopeId: 'org',
  allowedModels: [],
  deniedModels: [],
  locked: false,
  reasoningEffort: 'auto',
  ...over,
});

const TEXTS = [
  'Refactor this TypeScript repository and add unit tests',
  'Prove step by step that there are infinitely many primes',
  'Summarize this article in three bullets',
  'hello there',
];
const ALIASES = ['auto', 'auto/smart', 'auto/coding', 'auto/fast', 'auto/cheap'];

describe('automatic routing controls', () => {
  let env: PolicyGateway;
  const mockBodies = async () =>
    (
      (await (await fetch(`${env.mockRoot}/__mock/stats`)).json()) as {
        last: Record<string, unknown>[];
      }
    ).last;

  beforeAll(async () => {
    env = await policyGateway({
      combos: [
        {
          id: 'cmb-chain',
          organizationId: 'org',
          slug: 'big-chain',
          strategy: 'priority',
          targets: [
            { modelId: 'org-big', order: 0 },
            { modelId: 'org-cheap', order: 1 },
          ],
        },
      ],
      settings: {
        autoRouting: {
          enabled: true,
          // Expensive targets everywhere; only the pool has cheaper choices.
          targets: {
            coding: 'big-chain',
            reasoning: 'big',
            chat: 'big',
            summarization: 'mid',
            smart: 'big',
          },
          pool: ['big', 'mid', 'cheap'],
        },
      },
      autoPolicies: [policy({ costTier: 'low' })],
    });
  });
  afterAll(async () => {
    await env.close();
  });

  it('with the cost tier low no request reaches an expensive model', async () => {
    const start = env.usage.length;
    for (const alias of ALIASES)
      for (const text of TEXTS) {
        const res = await env.chat(KEYS.teamA, alias, { text });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-dirouter-model')).toBe('cheap');
      }
    const events = env.usage.slice(start);
    expect(events).toHaveLength(ALIASES.length * TEXTS.length);
    expect(events.every((e) => e.resolvedModelId === 'org-cheap')).toBe(true);
    expect(events.every((e) => e.attempts.every((a) => a.modelId === 'org-cheap'))).toBe(true);
    expect(events[0]?.routing).toMatchObject({ costTier: 'low' });
    expect(events[0]?.routing?.reasons).toContain('cost tier low: up to $1 per million tokens');
  });

  it("a combo's expensive target is dropped, not tried", async () => {
    const res = await env.chat(KEYS.teamA, 'auto/coding', { text: 'debug this python' });
    expect(res.headers.get('x-dirouter-model')).toBe('cheap');
    expect(env.usage.at(-1)?.routing?.target).toBe('big-chain');
  });

  it('never selects a model outside the allowed set, and a locked organization cannot be widened', async () => {
    await env.publish({
      autoPolicies: [
        policy({ allowedModels: ['mid'] }),
        policy({ scope: 'key', scopeId: 'vk-b', allowedModels: ['big'] }),
      ],
    });
    for (const alias of ALIASES)
      for (const text of TEXTS) {
        const res = await env.chat(KEYS.teamA, alias, { text });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-dirouter-model')).toBe('mid');
      }
    // Unlocked: the key's own set replaces the organization's.
    expect((await env.chat(KEYS.teamB, 'auto')).headers.get('x-dirouter-model')).toBe('big');
    // Locked: the key's set only narrows; nothing is in both, so nothing may be picked.
    await env.publish({
      autoPolicies: [
        policy({ allowedModels: ['mid', 'cheap'], locked: true }),
        policy({ scope: 'key', scopeId: 'vk-b', allowedModels: ['big'] }),
      ],
    });
    const refused = await env.chat(KEYS.teamB, 'auto');
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).toContain('pool');
    // Team A has no key policy: the organization's set decides (the cheapest capable pool entry).
    expect((await env.chat(KEYS.teamA, 'auto')).headers.get('x-dirouter-model')).toBe('cheap');
    // Denied models are out, whoever allows them.
    await env.publish({ autoPolicies: [policy({ deniedModels: ['m*'] })] });
    const res = await env.chat(KEYS.teamA, 'auto/cheap');
    expect(res.headers.get('x-dirouter-model')).toBe('cheap');
    const fast = await env.chat(KEYS.teamA, 'auto', { text: 'Summarize this article' });
    expect(fast.headers.get('x-dirouter-model')).not.toBe('mid');
  });

  it('leaves names the client asks for directly alone', async () => {
    await env.publish({ autoPolicies: [policy({ costTier: 'low' })] });
    expect((await env.chat(KEYS.teamA, 'big')).headers.get('x-dirouter-model')).toBe('big');
  });

  it('picks a reasoning effort when the client sent none, and records it', async () => {
    await env.publish({ autoPolicies: [policy({ costTier: 'medium' })] });
    const res = await env.chat(KEYS.teamA, 'auto', {
      text: 'Prove step by step that the square root of 2 is irrational',
    });
    expect(res.status).toBe(200);
    expect(env.usage.at(-1)?.routing).toMatchObject({
      reasoningEffort: 'medium',
      costTier: 'medium',
    });
    expect((await mockBodies()).at(-1)).toMatchObject({ reasoning_effort: 'medium' });
    // The client's own choice wins, and `off` leaves it to the client.
    await env.chat(KEYS.teamA, 'auto', { text: 'prove it', body: { reasoning_effort: 'high' } });
    expect((await mockBodies()).at(-1)).toMatchObject({ reasoning_effort: 'high' });
    await env.publish({ autoPolicies: [policy({ reasoningEffort: 'off' })] });
    await env.chat(KEYS.teamA, 'auto', { text: 'Prove step by step that 2 is prime' });
    expect((await mockBodies()).at(-1)).not.toHaveProperty('reasoning_effort');
    expect(env.usage.at(-1)?.routing?.reasoningEffort).toBeUndefined();
  });

  it("never applies another organization's policy", async () => {
    await env.publish({
      autoPolicies: [policy({ organizationId: 'org-2', scopeId: 'org-2', costTier: 'low' })],
    });
    expect(
      (await env.chat(KEYS.teamA, 'auto', { text: 'hello' })).headers.get('x-dirouter-model'),
    ).toBe('big');
  });
});
