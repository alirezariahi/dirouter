/**
 * rate limit در مسیر درخواست (کارت ۶.۱): 429 با Retry-After و هدرهای x-ratelimit-* در هر
 * دو فرمت، سقف پروژه، و هدرها در stream. limiter اینجا محلی است (بدون Valkey).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const RPM2 = 'dr-limits-rpm2-0001';
const PROJ_A = 'dr-limits-proj-0001';
const PROJ_B = 'dr-limits-proj-0002';
const mock = buildMock();
let gw: ReturnType<typeof buildGateway>;
let base = '';

const vk = (id: string, raw: string, projectId: string, rateLimit?: object) => ({
  id,
  hash: hashApiKey(raw, pepper),
  prefix: raw.slice(0, 8),
  organizationId: 'org',
  teamId: null,
  projectId,
  enabled: true,
  expiresAt: null,
  ...(rateLimit ? { rateLimit } : {}),
});

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const ma = mock.server.address();
  const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      {
        id: 'ok',
        organizationId: 'org',
        slug: 'ok',
        type: 'openai-compatible',
        name: 'ok',
        baseUrl: `${mockRoot}/v1`,
        enabled: true,
        options: {},
        credentials: [
          { id: 'ok-k', name: 'k', secret: encrypt(keyring, 'sk-x', 'ok-k'), enabled: true },
        ],
      },
    ],
    models: [
      {
        id: 'm',
        organizationId: 'org',
        slug: 'm',
        providerId: 'ok',
        upstreamModel: 'mock-small',
        enabled: true,
        pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
        capabilities: {},
      },
    ],
    combos: [],
    aliases: [],
    virtualKeys: [
      vk('vk-rpm2', RPM2, 'prj-1', { requestsPerMinute: 2 }),
      vk('vk-a', PROJ_A, 'prj-limited'),
      vk('vk-b', PROJ_B, 'prj-limited'),
    ],
    limits: [
      {
        organizationId: 'org',
        scope: 'project',
        scopeId: 'prj-limited',
        rateLimit: { requestsPerMinute: 3 },
      },
    ],
    settings: {},
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-limits-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
  gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper,
    dataDir,
    emitUsage: () => undefined,
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const ga = gw.app.server.address();
  base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
});

afterAll(async () => {
  await gw.app.close();
  await mock.close();
});

const chat = (key: string, stream = false) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('rate limits on the request path', () => {
  it('key rpm: headers on success, then 429 with Retry-After in both formats', async () => {
    const first = await chat(RPM2);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit-requests')).toBe('2');
    expect(first.headers.get('x-ratelimit-remaining-requests')).toBe('1');
    expect(first.headers.get('x-ratelimit-reset-requests')).toMatch(/^\d+(ms|s)$/);
    // stream هم هدرها را دارد.
    const streamed = await chat(RPM2, true);
    expect(streamed.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    await streamed.text();

    const limited = await chat(RPM2);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(50);
    expect(limited.headers.get('x-ratelimit-remaining-requests')).toBe('0');
    expect(await limited.json()).toMatchObject({
      error: {
        type: 'rate_limit_error',
        code: 'rate_limited',
        message: 'Rate limit exceeded for key (requests)',
      },
    });
    const anthropic = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': RPM2,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'm',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });
    expect(anthropic.status).toBe(429);
    expect(await anthropic.json()).toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error' },
    });
  });

  it('a project limit is shared by every key in the project', async () => {
    const statuses = [];
    for (const key of [PROJ_A, PROJ_B, PROJ_A, PROJ_B]) statuses.push((await chat(key)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('limiter state is visible to internal health', () => {
    expect(gw.limiter.stats.local).toBeGreaterThan(0);
    expect(gw.limiter.stats.rejected).toBeGreaterThan(0);
  });
});
