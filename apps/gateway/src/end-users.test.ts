/**
 * End users (card 33.2): attribution from the header or the body, default and own limits per end
 * user, blocking, and the usage event. The request path runs with INTEGRATION_VALKEY_URL.
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

describe('end-user attribution', () => {
  it('takes the header first, then the body; trims; ignores what cannot be an id', () => {
    expect(requestAttribution({ 'x-dirouter-end-user': ' alice ' }, 'bob')).toEqual({
      endUser: 'alice',
    });
    expect(requestAttribution({}, 'bob')).toEqual({ endUser: 'bob' });
    expect(requestAttribution({}, undefined)).toEqual({});
    expect(requestAttribution({}, 42)).toEqual({});
    expect(requestAttribution({}, '   ')).toEqual({});
    // `*` is the id of the defaults, never a real end user; control characters and huge ids
    // are not tracked.
    expect(requestAttribution({ 'x-dirouter-end-user': '*' })).toEqual({});
    expect(requestAttribution({}, 'a\nb')).toEqual({});
    expect(requestAttribution({}, 'x'.repeat(257))).toEqual({});
    expect(requestAttribution({}, 'x'.repeat(256)).endUser).toHaveLength(256);
  });
});

describe.skipIf(!VALKEY_URL)('end-user limits on the request path', () => {
  const mock = buildMock();
  let redis: Redis;
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  const events: UsageEvent[] = [];
  const KEY = 'dr-endusers-key-0001';
  const OTHER = 'dr-endusers-other-01';
  const run = randomUUID().slice(0, 8);
  const alice = `alice-${run}`;
  const bob = `bob-${run}`;
  const vip = `vip-${run}`;
  const mallory = `mallory-${run}`;
  const slow = `slow-${run}`;

  beforeAll(async () => {
    redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false, lazyConnect: true });
    await redis.connect();
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const upstream = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}/v1`;
    const provider = (organizationId: string) => ({
      id: `p-${organizationId}`,
      organizationId,
      slug: 'p',
      type: 'openai-compatible' as const,
      name: 'p',
      baseUrl: upstream,
      enabled: true,
      options: {},
      credentials: [
        {
          id: `c-${organizationId}`,
          name: 'c',
          secret: encrypt(keyring, 'sk-x', `c-${organizationId}`),
          enabled: true,
        },
      ],
    });
    const model = (organizationId: string) => ({
      id: `m-${organizationId}`,
      organizationId,
      slug: 'm',
      providerId: `p-${organizationId}`,
      upstreamModel: 'mock-small',
      enabled: true,
      // About $0.01 per request.
      pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
      capabilities: {},
    });
    const key = (raw: string, id: string, organizationId: string) => ({
      id,
      hash: hashApiKey(raw, pepper),
      prefix: id,
      organizationId,
      teamId: null,
      projectId: `prj-${organizationId}`,
      enabled: true,
      expiresAt: null,
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [provider('saas'), provider('other')],
      models: [model('saas'), model('other')],
      combos: [],
      aliases: [],
      virtualKeys: [key(KEY, 'vk-saas', 'saas'), key(OTHER, 'vk-other', 'other')],
      limits: [
        // Every end user of the SaaS gets 3 cents a day and 50 requests a minute of its own.
        {
          organizationId: 'saas',
          scope: 'end_user',
          scopeId: '*',
          rateLimit: { requestsPerMinute: 50 },
          budgets: [{ id: `eu-default-${run}`, period: 'daily', limitUsd: '0.03' }],
        },
        // A paying customer gets a budget of its own instead of the default.
        {
          organizationId: 'saas',
          scope: 'end_user',
          scopeId: vip,
          rateLimit: { requestsPerMinute: 100 },
          budgets: [{ id: `eu-vip-${run}`, period: 'monthly', limitUsd: '100' }],
        },
        { organizationId: 'saas', scope: 'end_user', scopeId: mallory, budgets: [], blocked: true },
        // Its own rate limit replaces the default one; the default budget still applies.
        {
          organizationId: 'saas',
          scope: 'end_user',
          scopeId: slow,
          rateLimit: { requestsPerMinute: 1 },
          budgets: [],
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-end-users-'));
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

  const chat = async (raw: string, user?: string, header?: string) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${raw}`,
        'content-type': 'application/json',
        ...(header ? { 'x-dirouter-end-user': header } : {}),
      },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        ...(user ? { user } : {}),
      }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    await settle();
    return { status: res.status, body };
  };

  it('an end user with a used-up budget gets 429 and the others keep working', async () => {
    const statuses: number[] = [];
    // Named in the body and in the header alike.
    for (let i = 0; i < 10 && statuses.at(-1) !== 429; i++)
      statuses.push((await chat(KEY, i % 2 ? alice : undefined, i % 2 ? undefined : alice)).status);
    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
    const refused = await chat(KEY, alice);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({
      code: 'budget_exceeded',
      message: 'Daily end user budget exceeded (USD 0.03)',
    });
    expect((await chat(KEY, bob)).status).toBe(200);
    // Requests that name no end user are not covered by end-user limits.
    expect((await chat(KEY)).status).toBe(200);
    // The same id in another organization is another end user.
    expect((await chat(OTHER, alice)).status).toBe(200);
    // Each end user has a counter of its own for the default budget.
    const counters = await redis.keys(`dirouter:budget:eu-default-${run}:eu:*`);
    expect(counters).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`:eu:${alice}:d:`),
        expect.stringContaining(`:eu:${bob}:d:`),
      ]),
    );
  });

  it("an end user's own rate limit replaces the default one", async () => {
    expect((await chat(KEY, slow)).status).toBe(200);
    const second = await chat(KEY, slow);
    expect(second.status).toBe(429);
    expect(second.body.error?.message).toBe('Rate limit exceeded for end user (requests)');
  });

  it('an end user with limits of its own is not held to the defaults', async () => {
    for (let i = 0; i < 6; i++) expect((await chat(KEY, vip)).status).toBe(200);
  });

  it('a blocked end user gets 403, by body or header', async () => {
    const refused = await chat(KEY, mallory);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({ code: 'end_user_blocked' });
    expect((await chat(KEY, undefined, mallory)).status).toBe(403);
  });

  it('usage events carry the end user, from the header as well', async () => {
    const before = events.length;
    await chat(KEY, undefined, bob);
    const event = events.slice(before).find((e) => e.status === 'success');
    expect(event?.endUser).toBe(bob);
  });
});
