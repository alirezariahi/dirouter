/** Platform marketplace (card 19.4): customer keys reach the operator's public models. */
import { ConfigSnapshot, type VirtualKeyConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { HealthRegistry, isRouteError, RouteIndex, Router } from './index.js';

const model = (id: string, organizationId: string, slug: string, isPublic?: boolean) => ({
  id,
  organizationId,
  slug,
  providerId: 'p',
  upstreamModel: id,
  enabled: true,
  pricing: { inputPerMTok: '1', outputPerMTok: '2' },
  capabilities: {},
  ...(isPublic !== undefined ? { public: isPublic } : {}),
});

const snapshot = ConfigSnapshot.parse({
  schemaVersion: 1,
  version: 1,
  generatedAt: '2026-11-23T00:00:00.000Z',
  platformOrganizationId: 'platform',
  providers: [
    {
      id: 'p',
      organizationId: 'platform',
      slug: 'p',
      type: 'openai',
      name: 'p',
      baseUrl: 'https://p.test/v1',
      enabled: true,
      options: {},
      credentials: [{ id: 'k', name: 'k', secret: 'v1.AAAA', enabled: true }],
    },
  ],
  models: [
    model('pub', 'platform', 'shop/fast', true),
    model('priv', 'platform', 'shop/internal', false),
    model('own', 'customer', 'shop/fast'),
  ],
  combos: [
    {
      id: 'cmb',
      organizationId: 'platform',
      slug: 'shop/auto',
      strategy: 'priority',
      targets: [{ modelId: 'pub', order: 0 }],
      public: true,
    },
  ],
  aliases: [
    { organizationId: 'platform', slug: 'shortcut', target: { kind: 'model', modelId: 'pub' } },
  ],
  virtualKeys: [],
  settings: {},
});

const key = (organizationId: string): VirtualKeyConfig => ({
  id: `vk-${organizationId}`,
  hash: 'a'.repeat(64),
  prefix: 'dr-x',
  organizationId,
  teamId: null,
  projectId: 'prj',
  enabled: true,
  expiresAt: null,
  allowedModels: [],
  ipAllowlist: [],
  budgets: [],
});

describe('marketplace', () => {
  const index = new RouteIndex(snapshot);

  it('a customer reaches public platform models and combos, never private ones or aliases', () => {
    expect(index.lookup('other', 'shop/fast')).toMatchObject({ model: { id: 'pub' } });
    expect(index.lookup('other', 'shop/auto')).toMatchObject({ combo: { id: 'cmb' } });
    expect(index.lookup('other', 'shop/internal')).toBeUndefined();
    expect(index.lookup('other', 'shortcut')).toBeUndefined();
    expect(index.names('other').sort()).toEqual(['shop/auto', 'shop/fast']);
  });

  it("an organization's own name wins over the marketplace", () => {
    expect(index.lookup('customer', 'shop/fast')).toMatchObject({ model: { id: 'own' } });
  });

  it('the platform itself sees all its models', () => {
    expect(index.lookup('platform', 'shop/internal')).toMatchObject({ model: { id: 'priv' } });
    expect(index.lookup('platform', 'shortcut')).toMatchObject({ model: { id: 'pub' } });
  });

  it('routes a customer key to the platform model', () => {
    const route = new Router(index, new HealthRegistry()).resolve(key('other'), 'shop/fast');
    expect(isRouteError(route)).toBe(false);
    if (!isRouteError(route)) expect(route.candidates[0]?.model.id).toBe('pub');
  });
});
