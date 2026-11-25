/**
 * Team and project budgets from the snapshot's `limits` (card 25.5): once a project's monthly
 * budget is reached, every key of that project gets `budget_exceeded`, keys of other projects do
 * not; a team budget covers the keys of all its projects. Runs with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const settle = () => new Promise((r) => setTimeout(r, 60));

describe.skipIf(!VALKEY_URL)('team and project budgets on the request path', () => {
  const keyring = parseKeyring(generateKey());
  const pepper = 'p'.repeat(32);
  const mock = buildMock();
  const redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false });
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  const KEYS = {
    searchA: 'dr-scope-search-a1',
    searchB: 'dr-scope-search-b1',
    billing: 'dr-scope-billing-1',
    teamX: 'dr-scope-team-x-01',
    teamY: 'dr-scope-team-y-01',
    other: 'dr-scope-other-001',
  };
  const key = (raw: string, id: string, projectId: string, teamId: string | null) => ({
    id,
    hash: hashApiKey(raw, pepper),
    prefix: id,
    organizationId: 'org',
    teamId,
    projectId,
    enabled: true,
    expiresAt: null,
  });

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const run = randomUUID();
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'p',
          organizationId: 'org',
          slug: 'p',
          type: 'openai-compatible',
          name: 'p',
          baseUrl: `${mockRoot}/v1`,
          enabled: true,
          options: {},
          credentials: [
            { id: 'k', name: 'k', secret: encrypt(keyring, 'sk-x', 'k'), enabled: true },
          ],
        },
      ],
      // About $0.01 per request, so a few requests reach a cap of a few cents.
      models: [
        {
          id: 'm',
          organizationId: 'org',
          slug: 'm',
          providerId: 'p',
          upstreamModel: 'mock-small',
          enabled: true,
          pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
          capabilities: {},
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        key(KEYS.searchA, 'vk-search-a', 'prj-search', null),
        key(KEYS.searchB, 'vk-search-b', 'prj-search', null),
        key(KEYS.billing, 'vk-billing', 'prj-billing', null),
        key(KEYS.teamX, 'vk-team-x', 'prj-x', 'team-core'),
        key(KEYS.teamY, 'vk-team-y', 'prj-y', 'team-core'),
        key(KEYS.other, 'vk-other', 'prj-other', 'team-other'),
      ],
      // What control-api's limits endpoints write (card 25.5), as the snapshot carries it.
      limits: [
        {
          organizationId: 'org',
          scope: 'project',
          scopeId: 'prj-search',
          budgets: [{ id: `bud-project-${run}`, period: 'monthly', limitUsd: '0.03' }],
        },
        {
          organizationId: 'org',
          scope: 'team',
          scopeId: 'team-core',
          budgets: [{ id: `bud-team-${run}`, period: 'daily', limitUsd: '0.03' }],
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-scope-budget-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger: createLogger({ service: 'test', level: 'silent' }),
      keyring,
      pepper,
      dataDir,
      emitUsage: () => undefined,
      limiterRedis: redis,
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });

  afterAll(async () => {
    await gw.app.close();
    await mock.close();
    redis.disconnect();
  });

  const chat = async (raw: string) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    await settle();
    return { status: res.status, body };
  };

  it('a project budget, once reached, stops every key of that project and no other', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10 && statuses.at(-1) !== 429; i++)
      statuses.push((await chat(KEYS.searchA)).status);
    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
    // The other key of the same project never spent anything, and is stopped as well.
    const sibling = await chat(KEYS.searchB);
    expect(sibling.status).toBe(429);
    expect(sibling.body.error).toMatchObject({
      code: 'budget_exceeded',
      message: 'Monthly project budget exceeded (USD 0.03)',
    });
    // A key of another project is not affected.
    expect((await chat(KEYS.billing)).status).toBe(200);
  });

  it('a team budget covers the keys of all its projects', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10 && statuses.at(-1) !== 429; i++)
      statuses.push((await chat(KEYS.teamX)).status);
    expect(statuses.at(-1)).toBe(429);
    const sibling = await chat(KEYS.teamY);
    expect(sibling.status).toBe(429);
    expect(sibling.body.error?.message).toBe('Daily team budget exceeded (USD 0.03)');
    expect((await chat(KEYS.other)).status).toBe(200);
  });
});
