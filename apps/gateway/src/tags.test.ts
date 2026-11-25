/**
 * Tags and cost centers (card 33.4): attribution from the key and the headers, tag and
 * cost-center budgets on the request path (with INTEGRATION_VALKEY_URL), and the usage event.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { requestAttribution } from './attribution.js';
import { buildGateway } from './server.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const settle = () => new Promise((r) => setTimeout(r, 60));

describe('tag and cost-center attribution', () => {
  it('adds the request tags to the key tags, distinct, valid and at most ten', () => {
    expect(
      requestAttribution({ 'x-dirouter-tags': 'search, team:ads,search,bad tag,' }, undefined, {
        tags: ['prod'],
      }),
    ).toEqual({ tags: ['prod', 'search', 'team:ads'] });
    const many = Array.from({ length: 15 }, (_, i) => `t${String(i)}`).join(',');
    expect(requestAttribution({ 'x-dirouter-tags': many }).tags).toHaveLength(10);
    expect(requestAttribution({ 'x-dirouter-tags': ['a', 'b,c'] }).tags).toEqual(['a', 'b', 'c']);
  });

  it("keeps the key's cost center; only a key without one takes the header's", () => {
    // The header cannot move a key's spend out of its cost center (and its budget).
    expect(
      requestAttribution({ 'x-dirouter-cost-center': 'cc-42' }, undefined, { costCenter: 'cc-1' }),
    ).toEqual({ costCenter: 'cc-1' });
    expect(requestAttribution({ 'x-dirouter-cost-center': 'cc-42' }, undefined, {})).toEqual({
      costCenter: 'cc-42',
    });
    expect(requestAttribution({}, undefined, { costCenter: 'cc-1' })).toEqual({
      costCenter: 'cc-1',
    });
    // An invalid header does not replace the key's cost center.
    expect(
      requestAttribution({ 'x-dirouter-cost-center': 'no spaces' }, undefined, {
        costCenter: 'cc-1',
      }),
    ).toEqual({ costCenter: 'cc-1' });
  });
});

describe.skipIf(!VALKEY_URL)('tag and cost-center budgets on the request path', () => {
  const mock = buildMock();
  let redis: Redis;
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  const events: UsageEvent[] = [];
  const run = randomUUID().slice(0, 8);
  const KEYS = {
    plain: 'dr-tags-plain-00001',
    tagged: 'dr-tags-tagged-0001',
    other: 'dr-tags-otherorg-01',
  };
  const tag = `campaign-${run}`;
  const cc = `cc-${run}`;

  beforeAll(async () => {
    redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false, lazyConnect: true });
    await redis.connect();
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const upstream = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}/v1`;
    const org = (id: string) => ({
      provider: {
        id: `p-${id}`,
        organizationId: id,
        slug: 'p',
        type: 'openai-compatible' as const,
        name: 'p',
        baseUrl: upstream,
        enabled: true,
        options: {},
        credentials: [
          { id: `c-${id}`, name: 'c', secret: encrypt(keyring, 'sk-x', `c-${id}`), enabled: true },
        ],
      },
      model: {
        id: `m-${id}`,
        organizationId: id,
        slug: 'm',
        providerId: `p-${id}`,
        upstreamModel: 'mock-small',
        enabled: true,
        // About $0.01 per request.
        pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
        capabilities: {},
      },
    });
    const key = (raw: string, id: string, organizationId: string, extra = {}) => ({
      id: `${id}-${run}`,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId,
      teamId: null,
      projectId: `prj-${organizationId}`,
      enabled: true,
      expiresAt: null,
      ...extra,
    });
    const a = org('a');
    const b = org('b');
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [a.provider, b.provider],
      models: [a.model, b.model],
      combos: [],
      aliases: [],
      virtualKeys: [
        key(KEYS.plain, 'vk-plain', 'a'),
        key(KEYS.tagged, 'vk-tagged', 'a', { tags: [tag], costCenter: 'cc-default' }),
        key(KEYS.other, 'vk-other', 'b'),
      ],
      limits: [
        {
          organizationId: 'a',
          scope: 'tag',
          scopeId: tag,
          budgets: [{ id: `tag-${run}`, period: 'daily', limitUsd: '0.03', alertThresholds: [] }],
        },
        {
          organizationId: 'a',
          scope: 'cost_center',
          scopeId: cc,
          budgets: [{ id: `cc-${run}`, period: 'monthly', limitUsd: '0.03', alertThresholds: [] }],
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-tags-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger: createLogger({ service: 'test', level: 'silent' }),
      keyring,
      pepper,
      dataDir,
      emitUsage: (event) => events.push(event),
      limiterRedis: redis,
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  }, 60_000);

  afterAll(async () => {
    await gw.app.close();
    await mock.close();
    redis.disconnect();
  });

  const chat = async (raw: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    await settle();
    return { status: res.status, body };
  };

  it("a tag's budget stops the requests carrying that tag and no others", async () => {
    let last = await chat(KEYS.plain, { 'x-dirouter-tags': `${tag},other` });
    for (let i = 0; i < 10 && last.status === 200; i++)
      last = await chat(KEYS.plain, { 'x-dirouter-tags': tag });
    expect(last.status).toBe(429);
    expect(last.body.error).toMatchObject({
      code: 'budget_exceeded',
      message: 'Daily tag budget exceeded (USD 0.03)',
    });
    // The key whose default tags include it is stopped as well.
    expect((await chat(KEYS.tagged)).status).toBe(429);
    // Other tags, no tag, and the same tag in another organization pass.
    expect((await chat(KEYS.plain, { 'x-dirouter-tags': 'other' })).status).toBe(200);
    expect((await chat(KEYS.plain)).status).toBe(200);
    expect((await chat(KEYS.other, { 'x-dirouter-tags': tag })).status).toBe(200);
  });

  it("a cost center's budget stops its requests", async () => {
    let last = await chat(KEYS.plain, { 'x-dirouter-cost-center': cc });
    for (let i = 0; i < 10 && last.status === 200; i++)
      last = await chat(KEYS.plain, { 'x-dirouter-cost-center': cc });
    expect(last.body.error?.message).toBe('Monthly cost center budget exceeded (USD 0.03)');
    expect((await chat(KEYS.plain, { 'x-dirouter-cost-center': 'cc-else' })).status).toBe(200);
  });

  it('usage events carry the tags and the cost center', async () => {
    const before = events.length;
    await chat(KEYS.plain, { 'x-dirouter-tags': 'a,b', 'x-dirouter-cost-center': 'cc-9' });
    expect(events.slice(before).at(-1)).toMatchObject({ tags: ['a', 'b'], costCenter: 'cc-9' });
  });
});
