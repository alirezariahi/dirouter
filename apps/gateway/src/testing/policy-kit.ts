/**
 * Test kit for the routing policy stages (sprint 5): a gateway in front of the mock provider with
 * a handful of models priced from cheap to expensive, keys in two teams and a second organization.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import type { Redis } from 'ioredis';

import { buildGateway } from '../server.js';

export const PEPPER = 'p'.repeat(32);
export const INTERNAL_TOKEN = 'i'.repeat(32);
export const KEYS = {
  teamA: 'dr-policy-team-a-01',
  teamB: 'dr-policy-team-b-01',
  allowed: 'dr-policy-allowed-1',
  other: 'dr-policy-other-org',
} as const;

type Model = ConfigSnapshotInput['models'][number];

export interface PolicyGateway {
  base: string;
  usage: UsageEvent[];
  mockRoot: string;
  gw: ReturnType<typeof buildGateway>;
  chat(
    key: string,
    model: string,
    options?: { text?: string; headers?: Record<string, string>; body?: Record<string, unknown> },
  ): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }>;
  /** Replaces the snapshot (a newer version) and waits until the gateway has it. */
  publish(change: Partial<ConfigSnapshotInput>): Promise<void>;
  close(): Promise<void>;
}

export async function policyGateway(
  extra: Partial<ConfigSnapshotInput> = {},
  options: { redis?: Redis; budgetId?: string } = {},
): Promise<PolicyGateway> {
  const mock = buildMock();
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const ma = mock.server.address();
  const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
  const keyring = parseKeyring(generateKey());
  const provider = (id: string, secret: string, organizationId = 'org') => ({
    id,
    organizationId,
    slug: id,
    type: 'openai-compatible' as const,
    name: id,
    baseUrl: `${mockRoot}/v1`,
    enabled: true,
    options: {},
    credentials: [
      { id: `${id}-k`, name: 'k', secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
    ],
  });
  const model = (
    slug: string,
    providerId: string,
    price: string,
    organizationId = 'org',
    extraFields: Partial<Model> = {},
  ): Model => ({
    id: `${organizationId}-${slug}`,
    organizationId,
    slug,
    providerId,
    upstreamModel: 'mock-small',
    enabled: true,
    pricing: { inputPerMTok: price, outputPerMTok: price },
    capabilities: { tools: true, reasoning: true },
    ...extraFields,
  });
  const key = (
    raw: string,
    id: string,
    teamId: string | null,
    extraFields: Record<string, unknown> = {},
  ) => ({
    id,
    hash: hashApiKey(raw, PEPPER),
    prefix: id,
    organizationId: 'org',
    teamId,
    projectId: teamId ? `prj-${teamId}` : 'prj',
    enabled: true,
    expiresAt: null,
    ...extraFields,
  });
  let snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('p', 'sk-mock'),
      provider('broken', 'mock:status=500'),
      provider('slow', 'mock:latency=1500'),
      provider('p2', 'sk-mock-2', 'org-2'),
    ],
    models: [
      model('cheap', 'p', '0.1'),
      model('mid', 'p', '2'),
      model('big', 'p', '30'),
      model('canary', 'p', '1'),
      model('canary-broken', 'broken', '1'),
      model('shadow-slow', 'slow', '1'),
      model('shadow-broken', 'broken', '1'),
      model('big', 'p2', '30', 'org-2'),
    ],
    combos: [],
    aliases: [],
    virtualKeys: [
      key(KEYS.teamA, 'vk-a', 'team-a'),
      key(KEYS.teamB, 'vk-b', 'team-b'),
      key(KEYS.allowed, 'vk-allowed', 'team-a', { allowedModels: ['big'] }),
      { ...key(KEYS.other, 'vk-other', null), organizationId: 'org-2' },
    ],
    limits: options.budgetId
      ? [
          {
            organizationId: 'org',
            scope: 'team',
            scopeId: 'team-a',
            budgets: [{ id: options.budgetId, period: 'monthly', limitUsd: '100' }],
          },
        ]
      : [],
    settings: {},
    ...extra,
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-policy-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  const usage: UsageEvent[] = [];
  const gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper: PEPPER,
    internalToken: INTERNAL_TOKEN,
    dataDir,
    emitUsage: (e) => usage.push(e),
    ...(options.redis ? { limiterRedis: options.redis } : {}),
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const ga = gw.app.server.address();
  const base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  return {
    base,
    usage,
    mockRoot,
    gw,
    async chat(raw, name, opts = {}) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${raw}`,
          'content-type': 'application/json',
          ...opts.headers,
        },
        body: JSON.stringify({
          model: name,
          messages: [{ role: 'user', content: opts.text ?? 'hello' }],
          ...opts.body,
        }),
      });
      return {
        status: res.status,
        headers: res.headers,
        body: (await res.json()) as Record<string, unknown>,
      };
    },
    publish(change) {
      snapshot = {
        ...snapshot,
        ...change,
        version: snapshot.version + 1,
        generatedAt: new Date().toISOString(),
      };
      const ok = gw.store.apply(snapshot, 'test');
      return ok ? Promise.resolve() : Promise.reject(new Error('snapshot rejected'));
    },
    async close() {
      await gw.app.close();
      await mock.close();
    },
  };
}
