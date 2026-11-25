/** Provider preferences, fallback models and key policies (card 32.1). */
import {
  ConfigSnapshot,
  preferencesFromRequest,
  ProviderRequestObject,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  effectivePolicy,
  HealthRegistry,
  isPlanError,
  mergePreferences,
  planRoute,
  RouteIndex,
  Router,
  RouterStats,
} from './index.js';

const provider = (id: string, type = 'openai-compatible') => ({
  id,
  organizationId: 'org',
  slug: id,
  type,
  name: `Provider ${id.toUpperCase()}`,
  baseUrl: `https://${id}.test/v1`,
  enabled: true,
  options: {},
  credentials: [{ id: `${id}-k`, name: 'k', secret: 'v1.AAAA', enabled: true }],
});
const model = (id: string, providerId: string, input: string, output: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel: id,
  enabled: true,
  pricing: { inputPerMTok: input, outputPerMTok: output },
  capabilities: {},
});

const snapshot = ConfigSnapshot.parse({
  schemaVersion: 1,
  version: 1,
  generatedAt: '2026-11-25T00:00:00.000Z',
  providers: [provider('alpha', 'openai'), provider('beta', 'anthropic'), provider('gamma')],
  models: [
    model('m-alpha', 'alpha', '3', '12'),
    model('m-beta', 'beta', '1', '4'),
    model('m-gamma', 'gamma', '2', '8'),
    model('solo', 'beta', '1', '4'),
    model('other', 'gamma', '2', '8'),
  ],
  combos: [
    {
      id: 'c',
      organizationId: 'org',
      slug: 'chat',
      strategy: 'priority',
      targets: [
        { modelId: 'm-alpha', order: 0 },
        { modelId: 'm-beta', order: 1 },
        { modelId: 'm-gamma', order: 2 },
      ],
    },
  ],
  aliases: [],
  virtualKeys: [],
  settings: {},
});

const key = (extra: Partial<VirtualKeyConfig> = {}): VirtualKeyConfig => ({
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
  ...extra,
});

function setup() {
  const stats = new RouterStats();
  const router = new Router(new RouteIndex(snapshot), new HealthRegistry(), { stats });
  const plan = (input: Partial<Parameters<typeof planRoute>[1]> = {}) =>
    planRoute(router, { key: key(), model: 'chat', ...input });
  const providers = (input: Partial<Parameters<typeof planRoute>[1]> = {}) => {
    const r = plan(input);
    if (isPlanError(r)) throw new Error(r.error);
    return r.candidates.map((c) => c.provider.id);
  };
  return { router, stats, plan, providers };
}

describe('provider preferences (card 32.1)', () => {
  it('without preferences the combo order is unchanged', () => {
    expect(setup().providers()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('order puts the named providers first, by slug, type or name', () => {
    const { providers } = setup();
    expect(providers({ preferences: { order: ['gamma', 'beta'] } })).toEqual([
      'gamma',
      'beta',
      'alpha',
    ]);
    expect(providers({ preferences: { order: ['ANTHROPIC'] } })).toEqual([
      'beta',
      'alpha',
      'gamma',
    ]);
    expect(providers({ preferences: { order: ['Provider GAMMA'] } })[0]).toBe('gamma');
  });

  it('only and ignore filter providers and record why', () => {
    const { providers, plan } = setup();
    expect(providers({ preferences: { only: ['beta', 'gamma'] } })).toEqual(['beta', 'gamma']);
    expect(providers({ preferences: { ignore: ['beta'] } })).toEqual(['alpha', 'gamma']);
    const r = plan({ preferences: { ignore: ['beta'], only: ['alpha', 'beta'] } });
    expect(isPlanError(r)).toBe(false);
    if (!isPlanError(r))
      expect(r.skipped).toEqual(
        expect.arrayContaining([
          { modelId: 'm-beta', credentialId: 'beta-k', reason: 'provider_ignored' },
          { modelId: 'm-gamma', credentialId: 'gamma-k', reason: 'provider_not_in_only' },
        ]),
      );
  });

  it('allowFallbacks false keeps only the ordered providers, or only the first one', () => {
    const { providers } = setup();
    expect(providers({ preferences: { order: ['gamma'], allowFallbacks: false } })).toEqual([
      'gamma',
    ]);
    expect(providers({ preferences: { allowFallbacks: false } })).toEqual(['alpha']);
  });

  it('sort by price, throughput and latency', () => {
    const { providers, stats } = setup();
    expect(providers({ preferences: { sort: 'price' } })).toEqual(['beta', 'gamma', 'alpha']);
    stats.recordThroughput('m-gamma', 500, 1_000);
    stats.recordThroughput('m-alpha', 100, 1_000);
    // beta has no measurement yet and goes last.
    expect(providers({ preferences: { sort: 'throughput' } })).toEqual(['gamma', 'alpha', 'beta']);
    stats.recordLatency('m-beta', 50);
    stats.recordLatency('m-alpha', 400);
    expect(providers({ preferences: { sort: 'latency' } })).toEqual(['beta', 'alpha', 'gamma']);
    // order wins over sort; sort orders the rest.
    expect(providers({ preferences: { sort: 'price', order: ['alpha'] } })).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('max_price removes pricier candidates and fails clearly when none is left', () => {
    const { providers, plan } = setup();
    expect(providers({ preferences: { maxPrice: { prompt: 2 } } })).toEqual(['beta', 'gamma']);
    expect(providers({ preferences: { maxPrice: { completion: 4 } } })).toEqual(['beta']);
    const none = plan({ preferences: { maxPrice: { prompt: 0.5 } } });
    expect(none).toMatchObject({ error: 'no_provider_matches_preferences' });
    if (isPlanError(none))
      expect(none.skipped.map((s) => s.reason)).toEqual([
        'above_max_price_prompt',
        'above_max_price_prompt',
        'above_max_price_prompt',
      ]);
  });

  it('max_price compares what the customer pays (group multiplier)', () => {
    const { router } = setup();
    const r = planRoute(router, {
      key: key({ priceMultiplier: '2' }),
      model: 'solo',
      preferences: { maxPrice: { prompt: 1.5 } },
    });
    expect(r).toMatchObject({ error: 'no_provider_matches_preferences' });
  });

  it('the models array adds fallback models after the requested one', () => {
    const { plan, providers } = setup();
    const r = plan({ model: 'solo', fallbackModels: ['other', 'missing', 'solo'] });
    expect(isPlanError(r)).toBe(false);
    if (isPlanError(r)) return;
    expect(r.models).toEqual(['solo', 'other']);
    expect(r.candidates.map((c) => c.model.id)).toEqual(['solo', 'other']);
    expect(r.skipped).toContainEqual({ modelId: 'missing', reason: 'fallback_model_not_found' });
    // A missing primary model with a valid fallback still routes.
    expect(providers({ model: 'nope', fallbackModels: ['other'] })).toEqual(['gamma']);
    // A key restricted to some models cannot reach others through the fallback list.
    const { router } = setup();
    const limited = planRoute(router, {
      key: key({ allowedModels: ['solo'] }),
      model: 'solo',
      fallbackModels: ['other'],
    });
    if (!isPlanError(limited)) expect(limited.candidates.map((c) => c.model.id)).toEqual(['solo']);
  });
});

describe('request form (OpenRouter provider object)', () => {
  it('parses every field and ignores the ones DiRouter does not use', () => {
    const raw = ProviderRequestObject.parse({
      order: ['openai', 'anthropic'],
      only: ['openai', 'anthropic', 'groq'],
      ignore: ['deepinfra'],
      allow_fallbacks: false,
      sort: 'throughput',
      max_price: { prompt: 1, completion: '2.5' },
      require_parameters: true,
      quantizations: ['fp8'],
    });
    expect(preferencesFromRequest(raw)).toEqual({
      order: ['openai', 'anthropic'],
      only: ['openai', 'anthropic', 'groq'],
      ignore: ['deepinfra'],
      allowFallbacks: false,
      sort: 'throughput',
      maxPrice: { prompt: 1, completion: 2.5 },
    });
    expect(preferencesFromRequest(ProviderRequestObject.parse({ sort: { by: 'price' } }))).toEqual({
      sort: 'price',
    });
  });
});

describe('routing policy on the key (admin lock)', () => {
  const rules = [
    {
      organizationId: 'org',
      scope: 'organization' as const,
      scopeId: 'org',
      provider: { sort: 'price' as const, ignore: ['alpha'] },
    },
    {
      organizationId: 'org',
      scope: 'key' as const,
      scopeId: 'vk',
      provider: { only: ['beta', 'gamma'] },
      lockProvider: true,
    },
    { organizationId: 'other', scope: 'key' as const, scopeId: 'vk', lockProvider: false },
  ];

  it('combines the scopes, the most specific field winning', () => {
    const policy = effectivePolicy(rules, key());
    expect(policy).toEqual({
      provider: { sort: 'price', ignore: ['alpha'], only: ['beta', 'gamma'] },
      lockProvider: true,
      explain: false,
      sources: [
        { scope: 'organization', scopeId: 'org' },
        { scope: 'key', scopeId: 'vk' },
      ],
    });
  });

  it('a locked policy ignores the client; an open one lets the client override fields', () => {
    const locked = mergePreferences(effectivePolicy(rules, key()), { only: ['alpha'] });
    expect(locked).toEqual({
      preferences: { sort: 'price', ignore: ['alpha'], only: ['beta', 'gamma'] },
      clientIgnored: true,
    });
    const open = mergePreferences(effectivePolicy(rules.slice(0, 1), key()), {
      ignore: [],
      order: ['gamma'],
    });
    expect(open).toEqual({
      preferences: { sort: 'price', ignore: [], order: ['gamma'] },
      clientIgnored: false,
    });
    const { router } = setup();
    const r = planRoute(router, { key: key(), model: 'chat', preferences: locked.preferences });
    if (!isPlanError(r)) expect(r.candidates.map((c) => c.provider.id)).toEqual(['beta', 'gamma']);
  });
});
