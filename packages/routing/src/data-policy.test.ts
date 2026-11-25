/** Routing by data policy and region (card 32.5). */
import {
  ConfigSnapshot,
  dataPolicyFromRequest,
  mergeDataPolicies,
  ProviderRequestObject,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import {
  effectivePolicy,
  HealthRegistry,
  isPlanError,
  planRoute,
  RouteIndex,
  Router,
} from './index.js';

const provider = (id: string, dataPolicy?: Record<string, unknown>) => ({
  id,
  organizationId: 'org',
  slug: id,
  type: 'openai-compatible',
  name: id,
  baseUrl: `https://${id}.test/v1`,
  enabled: true,
  options: {},
  credentials: [{ id: `${id}-k`, name: 'k', secret: 'v1.AAAA', enabled: true }],
  ...(dataPolicy ? { dataPolicy } : {}),
});
const model = (id: string, providerId: string) => ({
  id,
  organizationId: 'org',
  slug: id,
  providerId,
  upstreamModel: id,
  enabled: true,
  pricing: { inputPerMTok: '1', outputPerMTok: '1' },
  capabilities: {},
});

const snapshot = ConfigSnapshot.parse({
  schemaVersion: 1,
  version: 1,
  generatedAt: '2026-11-25T00:00:00.000Z',
  providers: [
    provider('us-train', { region: 'us', country: 'US', zdr: false, trainsOnData: true }),
    provider('eu-zdr', { region: 'eu', country: 'DE', zdr: true, trainsOnData: false }),
    provider('eu-keep', { region: 'eu', country: 'FR', zdr: false, trainsOnData: false }),
    provider('unknown'),
  ],
  models: [
    model('m-us', 'us-train'),
    model('m-eu-zdr', 'eu-zdr'),
    model('m-eu-keep', 'eu-keep'),
    model('m-unknown', 'unknown'),
  ],
  combos: [
    {
      id: 'c',
      organizationId: 'org',
      slug: 'chat',
      strategy: 'priority',
      targets: ['m-us', 'm-unknown', 'm-eu-keep', 'm-eu-zdr'].map((modelId, order) => ({
        modelId,
        order,
      })),
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
const providers = (dataPolicy: Parameters<typeof planRoute>[1]['dataPolicy'], extra = {}) => {
  const r = planRoute(router, { key, model: 'chat', dataPolicy, ...extra });
  return isPlanError(r) ? r.error : r.candidates.map((c) => c.provider.id);
};

describe('data policy (card 32.5)', () => {
  it('ZDR only keeps zero-retention providers; unknown metadata never passes', () => {
    expect(providers({ requireZdr: true })).toEqual(['eu-zdr']);
    const r = planRoute(router, { key, model: 'chat', dataPolicy: { requireZdr: true } });
    if (!isPlanError(r))
      expect(r.skipped.map((s) => [s.modelId, s.reason])).toEqual([
        ['m-us', 'not_zdr'],
        ['m-unknown', 'not_zdr'],
        ['m-eu-keep', 'not_zdr'],
      ]);
  });

  it('training, region and country requirements', () => {
    expect(providers({ denyTraining: true })).toEqual(['eu-keep', 'eu-zdr']);
    expect(providers({ allowedRegions: ['eu'] })).toEqual(['eu-keep', 'eu-zdr']);
    expect(providers({ allowedCountries: ['US', 'FR'] })).toEqual(['us-train', 'eu-keep']);
    expect(providers({ allowedRegions: ['asia'] })).toBe('no_provider_matches_data_policy');
  });

  it('the data policy runs before preferences: no preference can bring a provider back', () => {
    expect(
      providers({ requireZdr: true }, { preferences: { order: ['us-train'], only: ['us-train'] } }),
    ).toBe('no_provider_matches_preferences');
    expect(providers({ requireZdr: true }, { fallbackModels: ['m-us'] })).toEqual(['eu-zdr']);
  });

  it('scopes and the request combine to the strictest; a request cannot weaken anything', () => {
    const rules = [
      {
        organizationId: 'org',
        scope: 'organization' as const,
        scopeId: 'org',
        dataPolicy: { requireZdr: true, allowedRegions: ['eu', 'us'] },
      },
      {
        organizationId: 'org',
        scope: 'project' as const,
        scopeId: 'prj',
        dataPolicy: { allowedRegions: ['eu'], requireZdr: false },
      },
    ];
    const policy = effectivePolicy(rules, key).dataPolicy;
    expect(policy).toEqual({ requireZdr: true, allowedRegions: ['eu'] });
    const weaker = dataPolicyFromRequest(
      ProviderRequestObject.parse({ zdr: false, data_collection: 'allow', regions: ['us', 'eu'] }),
    );
    expect(mergeDataPolicies(policy, weaker)).toEqual({ requireZdr: true, allowedRegions: ['eu'] });
    const stricter = dataPolicyFromRequest(
      ProviderRequestObject.parse({ data_collection: 'deny', countries: ['DE'] }),
    );
    expect(mergeDataPolicies(policy, stricter)).toEqual({
      requireZdr: true,
      allowedRegions: ['eu'],
      denyTraining: true,
      allowedCountries: ['DE'],
    });
  });
});
