/** Routing explanation (card 32.7). */
import { ConfigSnapshot, type VirtualKeyConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  effectivePolicy,
  encodeExplanation,
  explainPlan,
  HealthRegistry,
  isPlanError,
  planRoute,
  RouteIndex,
  Router,
  withAttempts,
} from './index.js';

const snapshot = ConfigSnapshot.parse({
  schemaVersion: 1,
  version: 1,
  generatedAt: '2026-11-25T00:00:00.000Z',
  providers: ['a', 'b'].map((id) => ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai-compatible',
    name: id,
    baseUrl: `https://${id}.test/v1`,
    enabled: true,
    options: {},
    credentials: [{ id: `${id}-k`, name: 'k', secret: 'v1.AAAA', enabled: true }],
    ...(id === 'a' ? { dataPolicy: { zdr: true } } : {}),
  })),
  models: ['a', 'b'].map((id, i) => ({
    id: `m-${id}`,
    organizationId: 'org',
    slug: `m-${id}`,
    providerId: id,
    upstreamModel: id,
    enabled: true,
    pricing: { inputPerMTok: String(i + 1), outputPerMTok: String(2 * (i + 1)) },
    capabilities: {},
  })),
  combos: [
    {
      id: 'c',
      organizationId: 'org',
      slug: 'chat',
      strategy: 'priority',
      targets: [
        { modelId: 'm-b', order: 0 },
        { modelId: 'm-a', order: 1 },
      ],
    },
  ],
  aliases: [],
  virtualKeys: [],
  settings: {},
});
const key: VirtualKeyConfig = {
  id: 'vk',
  hash: 'a'.repeat(64),
  prefix: 'dr-x',
  organizationId: 'org',
  teamId: null,
  projectId: 'prj',
  enabled: true,
  expiresAt: null,
  allowedModels: [],
  ipAllowlist: [],
  budgets: [],
  mcpTools: [],
};

describe('explainPlan', () => {
  const router = new Router(new RouteIndex(snapshot), new HealthRegistry());

  it('lists candidates with estimated prices, removals, rule and attempts', () => {
    const plan = planRoute(router, {
      key,
      model: 'chat',
      dataPolicy: { requireZdr: true },
      preferences: { sort: 'price' },
      rule: { id: 'rule_1', name: 'long prompts' },
      resolve: { estimatedInputTokens: 1_000_000, maxOutputTokens: 1_000_000 },
    });
    if (isPlanError(plan)) throw new Error(plan.error);
    const explanation = explainPlan(plan, {
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      suffixes: ['floor'],
    });
    expect(explanation).toEqual({
      requested: 'chat',
      models: ['chat'],
      kind: 'combo',
      combo: { slug: 'chat', strategy: 'priority' },
      rule: { id: 'rule_1', name: 'long prompts' },
      suffixes: ['floor'],
      dataPolicy: { requireZdr: true },
      preferences: { sort: 'price' },
      candidates: [
        {
          modelId: 'm-a',
          model: 'm-a',
          providerId: 'a',
          provider: 'a',
          credentialId: 'a-k',
          estimatedCostUsd: '3.00000000',
        },
      ],
      skipped: [{ modelId: 'm-b', credentialId: 'b-k', reason: 'not_zdr' }],
      estimatedCostUsd: '3.00000000',
      estimate: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    const ran = withAttempts(explanation, [
      {
        modelId: 'm-a',
        providerId: 'a',
        credentialId: 'a-k',
        outcome: 'success',
        latencyMs: 12,
      },
    ]);
    expect(ran.attempts).toEqual([
      { modelId: 'm-a', providerId: 'a', credentialId: 'a-k', outcome: 'success', latencyMs: 12 },
    ]);
    expect(JSON.parse(Buffer.from(encodeExplanation(ran), 'base64url').toString())).toEqual(ran);
  });

  it('the permission comes from the most specific scope that sets it', () => {
    const rule = (scope: 'organization' | 'key', explain: boolean) => ({
      organizationId: 'org',
      scope,
      scopeId: scope === 'key' ? 'vk' : 'org',
      explain,
    });
    expect(effectivePolicy([], key).explain).toBe(false);
    expect(effectivePolicy([rule('organization', true)], key).explain).toBe(true);
    expect(effectivePolicy([rule('organization', true), rule('key', false)], key).explain).toBe(
      false,
    );
  });
});
