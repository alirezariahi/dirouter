/**
 * Budgets of upstream providers and credentials, quota windows, and the fill-first and
 * reset-aware strategies (card 32.6). Runs with INTEGRATION_VALKEY_URL.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ConfigSnapshotInput, quotaWindowKey, type UsageEvent } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const settle = () => new Promise((r) => setTimeout(r, 80));
const KEY = 'dr-provider-budget-01';

describe.skipIf(!VALKEY_URL)('upstream budgets and quota windows on the request path', () => {
  const mock = buildMock();
  let redis: Redis;
  let gw: ReturnType<typeof buildGateway>;
  let base = '';
  const events: UsageEvent[] = [];
  const run = randomUUID().slice(0, 8);
  const id = (name: string) => `${name}-${run}`;

  beforeAll(async () => {
    redis = new Redis(VALKEY_URL ?? '', { enableOfflineQueue: false, lazyConnect: true });
    await redis.connect();
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const upstream = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}/v1`;
    const credential = (name: string, extra: Record<string, unknown> = {}) => ({
      id: id(name),
      name,
      secret: encrypt(keyring, `sk-${name}`, id(name)),
      enabled: true,
      ...extra,
    });
    const provider = (
      name: string,
      credentials: ReturnType<typeof credential>[],
      extra: Record<string, unknown> = {},
    ) => ({
      id: id(name),
      organizationId: 'org',
      slug: name,
      type: 'openai-compatible' as const,
      name,
      baseUrl: upstream,
      enabled: true,
      options: {},
      credentials,
      ...extra,
    });
    const model = (slug: string, providerName: string) => ({
      id: id(slug),
      organizationId: 'org',
      slug,
      providerId: id(providerName),
      upstreamModel: 'mock-small',
      enabled: true,
      // About $0.01 per request.
      pricing: { inputPerMTok: '1000', outputPerMTok: '1000' },
      capabilities: {},
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        // A credential with a budget, filled first.
        provider(
          'budgeted',
          [
            credential('first', {
              weight: 2,
              budgets: [{ id: id('cred-budget'), period: 'daily', limitUsd: '0.03' }],
            }),
            credential('second'),
          ],
          { credentialStrategy: 'fill-first' },
        ),
        // A coding plan: three requests per five hours on the first credential.
        provider(
          'plan',
          [
            credential('plan-a', { quotaWindows: [{ id: '5h', hours: 5, limitRequests: 3 }] }),
            credential('plan-b', { quotaWindows: [{ id: '5h', hours: 5, limitRequests: 100 }] }),
          ],
          { credentialStrategy: 'fill-first' },
        ),
        // Reset-aware: the window that ends sooner is used first.
        provider(
          'aware',
          [
            credential('aware-a', { quotaWindows: [{ id: 'w', hours: 168, limitRequests: 100 }] }),
            credential('aware-b', { quotaWindows: [{ id: 'w', hours: 168, limitRequests: 100 }] }),
          ],
          { credentialStrategy: 'reset-aware' },
        ),
        // A whole upstream account with a budget.
        provider('capped', [credential('capped-a')], {
          budgets: [{ id: id('provider-budget'), period: 'monthly', limitUsd: '0.02' }],
        }),
      ],
      models: [
        model('budgeted-m', 'budgeted'),
        model('plan-m', 'plan'),
        model('aware-m', 'aware'),
        model('capped-m', 'capped'),
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        {
          id: id('vk'),
          hash: hashApiKey(KEY, pepper),
          prefix: 'vk',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-provider-budgets-'));
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

  /** Status, error and the credential that served the request. */
  const chat = async (model: string) => {
    const before = events.length;
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    await settle();
    const credential = events.slice(before).find((e) => e.status === 'success')?.credentialId;
    return { status: res.status, body, credential, retryAfter: res.headers.get('retry-after') };
  };

  it('a credential at its cap hands the traffic to the next one without an error', async () => {
    const served: (string | null | undefined)[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await chat('budgeted-m');
      expect(res.status).toBe(200);
      served.push(res.credential);
    }
    // Fill-first: the heavier credential until its three cents are spent, then the other.
    const firstUses = served.filter((c) => c === id('first')).length;
    expect(served.slice(0, firstUses).every((c) => c === id('first'))).toBe(true);
    expect(firstUses).toBeGreaterThanOrEqual(2);
    expect(served.slice(firstUses).every((c) => c === id('second'))).toBe(true);
    expect(served.at(-1)).toBe(id('second'));
  });

  it('fill-first uses one credential up to its quota window, then the next', async () => {
    const served: (string | null | undefined)[] = [];
    for (let i = 0; i < 5; i++) served.push((await chat('plan-m')).credential);
    expect(served).toEqual([id('plan-a'), id('plan-a'), id('plan-a'), id('plan-b'), id('plan-b')]);
    // The window started with the first request and lasts five hours.
    const ttl = await redis.pttl(quotaWindowKey(id('plan-a'), '5h'));
    expect(ttl).toBeGreaterThan(5 * 3_600_000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 3_600_000);
    expect(await redis.hget(quotaWindowKey(id('plan-a'), '5h'), 'requests')).toBe('3');
  });

  it('reset-aware spends the window that resets soonest first', async () => {
    // aware-b's weekly window started six days ago: one day left; aware-a has not started.
    await redis.hset(quotaWindowKey(id('aware-b'), 'w'), 'requests', 1, 'tokens', 0, 'usd', 0);
    await redis.pexpire(quotaWindowKey(id('aware-b'), 'w'), 86_400_000);
    expect((await chat('aware-m')).credential).toBe(id('aware-b'));
    // Once aware-a's window is running and ends sooner, it goes first.
    await redis.hset(quotaWindowKey(id('aware-a'), 'w'), 'requests', 1, 'tokens', 0, 'usd', 0);
    await redis.pexpire(quotaWindowKey(id('aware-a'), 'w'), 3_600_000);
    expect((await chat('aware-m')).credential).toBe(id('aware-a'));
  });

  it('a used-up provider budget or every quota used up refuses with the reset time', async () => {
    let last = await chat('capped-m');
    for (let i = 0; i < 6 && last.status === 200; i++) last = await chat('capped-m');
    expect(last.status).toBe(429);
    expect(last.body.error?.message).toBe(
      "Monthly provider account budget exceeded for every target of 'capped-m'",
    );
    await redis.hset(quotaWindowKey(id('plan-b'), '5h'), 'requests', 100);
    const refused = await chat('plan-m');
    expect(refused.status).toBe(429);
    expect(refused.body.error?.message).toBe(
      "Quota window used up on every credential for 'plan-m'",
    );
    expect(Number(refused.retryAfter)).toBeGreaterThan(4 * 3600);
  });
});
