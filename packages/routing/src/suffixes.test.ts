/** Model suffixes (card 31.5). */
import { ConfigSnapshot, type VirtualKeyConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  HealthRegistry,
  isPlanError,
  parseModelSuffixes,
  planRoute,
  RouteIndex,
  Router,
} from './index.js';

const known = new Set(['gpt', 'x:free', 'chat']);
const exists = (name: string) => known.has(name);

describe('parseModelSuffixes', () => {
  it('maps each suffix to its effect', () => {
    expect(parseModelSuffixes('gpt:nitro', exists)).toMatchObject({
      model: 'gpt',
      sort: 'throughput',
    });
    expect(parseModelSuffixes('gpt:floor', exists)).toMatchObject({ model: 'gpt', sort: 'price' });
    expect(parseModelSuffixes('gpt:free', exists)).toMatchObject({ model: 'gpt', freeOnly: true });
    expect(parseModelSuffixes('gpt:online', exists)).toMatchObject({
      model: 'gpt',
      webSearch: true,
    });
    expect(parseModelSuffixes('gpt:thinking', exists)).toMatchObject({ reasoningEffort: 'medium' });
    expect(parseModelSuffixes('gpt:high', exists)).toMatchObject({ reasoningEffort: 'high' });
  });

  it('chains suffixes and keeps names that exist as written', () => {
    expect(parseModelSuffixes('gpt:floor:online:low', exists)).toEqual({
      model: 'gpt',
      suffixes: ['floor', 'online', 'low'],
      sort: 'price',
      freeOnly: false,
      webSearch: true,
      reasoningEffort: 'low',
    });
    expect(parseModelSuffixes('x:free', exists)).toEqual({
      model: 'x:free',
      suffixes: [],
      freeOnly: false,
      webSearch: false,
    });
    // Unknown suffix or unknown base name: the name is left alone (and fails as written).
    expect(parseModelSuffixes('gpt:turbo', exists).model).toBe('gpt:turbo');
    expect(parseModelSuffixes('nope:floor', exists).model).toBe('nope:floor');
  });
});

describe('suffixes in the planner', () => {
  const model = (id: string, input: string, output: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    providerId: id,
    upstreamModel: id,
    enabled: true,
    pricing: { inputPerMTok: input, outputPerMTok: output },
    capabilities: {},
  });
  const provider = (id: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai-compatible',
    name: id,
    baseUrl: `https://${id}.test/v1`,
    enabled: true,
    options: {},
    credentials: [{ id: `${id}-k`, name: 'k', secret: 'v1.AAAA', enabled: true }],
  });
  const snapshot = ConfigSnapshot.parse({
    schemaVersion: 1,
    version: 1,
    generatedAt: '2026-11-25T00:00:00.000Z',
    providers: [provider('paid'), provider('cheap'), provider('free')],
    models: [model('paid', '3', '9'), model('cheap', '1', '2'), model('free', '0', '0')],
    combos: [
      {
        id: 'c',
        organizationId: 'org',
        slug: 'chat',
        strategy: 'priority',
        targets: ['paid', 'cheap', 'free'].map((modelId, order) => ({ modelId, order })),
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
    repair: [],
    passthroughProviders: [],
  };
  const router = new Router(new RouteIndex(snapshot), new HealthRegistry());
  const order = (name: string) => {
    const s = parseModelSuffixes(name, (n) => router.modelsFor(key, n) !== undefined);
    const r = planRoute(router, {
      key,
      model: s.model,
      freeOnly: s.freeOnly,
      ...(s.sort ? { preferences: { sort: s.sort } } : {}),
    });
    return isPlanError(r) ? r.error : r.candidates.map((c) => c.model.id);
  };

  it(':floor, :nitro and :free give the expected order', () => {
    expect(order('chat')).toEqual(['paid', 'cheap', 'free']);
    expect(order('chat:floor')).toEqual(['free', 'cheap', 'paid']);
    router.stats.recordThroughput('cheap', 900, 1_000);
    router.stats.recordThroughput('paid', 100, 1_000);
    expect(order('chat:nitro')).toEqual(['cheap', 'paid', 'free']);
    expect(order('chat:free')).toEqual(['free']);
    expect(order('paid:free')).toBe('no_provider_matches_preferences');
  });
});
