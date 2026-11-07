/** ساخت و انتشار Config Snapshot روی Postgres و Valkey واقعی (کارت ۳.۹). */
import { ConfigSnapshot } from '@dirouter/contracts';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { CONFIG_CHANNEL, SnapshotService } from './snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';
const INTERNAL = 'i'.repeat(32);
const SECRET = 'sk-snapshot-PLAINTEXT-7777';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('config snapshot', () => {
  let app: NestFastifyApplication;
  let sub: Redis;
  const published: string[] = [];
  let token = '';
  let org = '';

  const http = () => app.getHttpAdapter().getInstance();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    http().inject({
      method,
      url: `/api/v1/orgs/${org}/${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
  const snapshot = (etag?: string, auth = `Bearer ${INTERNAL}`) =>
    http().inject({
      method: 'GET',
      url: '/internal/config/snapshot',
      headers: { authorization: auth, ...(etag ? { 'if-none-match': etag } : {}) },
    });
  /** تا ساخت نسخهٔ تازه (debounce) صبر می‌کند. */
  const nextVersion = async (after: number) => {
    for (let i = 0; i < 100; i++) {
      const v = (await app.get(SnapshotService).latest())?.version ?? 0;
      if (v > after) return v;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no new snapshot version');
  };

  beforeAll(async () => {
    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: generateKey(),
      KEY_PEPPER: 'p'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: INTERNAL,
    });
    sub = new Redis(VALKEY_URL ?? '');
    sub.on('message', (_c: string, m: string) => published.push(m));
    await sub.subscribe(CONFIG_CHANNEL);
    app = await createApp(env);
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, budgets, api_keys, combo_targets, combos, model_aliases, credentials, models, providers, projects, teams, users, organizations, config_versions RESTART IDENTITY CASCADE',
    );
    await app.init();
    await http().ready();
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    token = (
      await http().inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { organizationName: 'Snap Org', name: 'O', email: 's@example.com', password: PW },
      })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await http().inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
  });

  afterAll(async () => {
    sub.disconnect();
    await app.close();
  });

  it('is only served with the internal token', async () => {
    expect((await snapshot(undefined, 'Bearer wrong')).statusCode).toBe(404);
    expect(
      (await http().inject({ method: 'GET', url: '/internal/config/snapshot' })).statusCode,
    ).toBe(404);
  });

  it('every effective change creates a new, increasing version and is announced on Valkey', async () => {
    const v0 = (await app.get(SnapshotService).latest())?.version ?? 0;
    const provider = (
      await call('POST', 'providers', {
        name: 'OpenAI',
        type: 'openai',
        credentials: [{ name: 'k', secret: SECRET }],
      })
    ).json<{ id: string }>().id;
    const v1 = await nextVersion(v0);
    const model = (
      await call('POST', 'models', {
        providerId: provider,
        upstreamModel: 'gpt-4.1',
        catalogKey: 'openai/gpt-4.1',
      })
    ).json<{ id: string }>().id;
    const v2 = await nextVersion(v1);
    const project = (await call('POST', 'projects', { name: 'P' })).json<{ id: string }>().id;
    await call('POST', 'combos', { slug: 'smart', targets: [{ modelId: model }] });
    await call('POST', 'keys', {
      name: 'k',
      projectId: project,
      rpm: 60,
      budgets: [{ period: 'daily', limitUsd: '5' }],
    });
    const v3 = await nextVersion(v2);
    expect(v1).toBeGreaterThan(v0);
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);
    await new Promise((r) => setTimeout(r, 100));
    expect(published.map(Number)).toEqual(expect.arrayContaining([v1, v2, v3]));
  });

  it('a rebuild without changes does not create a version', async () => {
    const before = (await app.get(SnapshotService).latest())?.version;
    expect(await app.get(SnapshotService).rebuild('noop')).toBe(before);
  });

  it('serves a valid snapshot with ETag and 304, and no decrypted secret', async () => {
    const res = await snapshot();
    expect(res.statusCode).toBe(200);
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"v\d+-[0-9a-f]{16}"$/);
    const snap = ConfigSnapshot.parse(res.json());
    expect(snap.providers[0]?.credentials[0]?.secret).toMatch(/^v\d+\./);
    expect(res.body).not.toContain('PLAINTEXT');
    expect(snap.models[0]?.pricing).toMatchObject({ inputPerMTok: '2', outputPerMTok: '8' });
    expect(snap.combos[0]).toMatchObject({ slug: 'smart', retry: { maxAttempts: 2 } });
    expect(snap.virtualKeys[0]).toMatchObject({
      rateLimit: { requestsPerMinute: 60 },
      budgets: [{ period: 'daily', limitUsd: '5' }],
    });
    expect(snap.virtualKeys[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await snapshot(etag);
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('a revoked key disappears from the next snapshot', async () => {
    const key = (await call('GET', 'keys')).json<{ id: string }[]>()[0]?.id ?? '';
    const before = (await app.get(SnapshotService).latest())?.version ?? 0;
    await call('POST', `keys/${key}/revoke`);
    await nextVersion(before);
    const snap = ConfigSnapshot.parse((await snapshot()).json());
    expect(snap.virtualKeys.map((k) => k.id)).not.toContain(key);
  });
});
