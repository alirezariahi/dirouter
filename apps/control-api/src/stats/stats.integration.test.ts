/** API آمار و لاگ روی Postgres و Valkey واقعی (کارت ۳.۱۰). */
import { createServer, type Server } from 'node:http';

import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { decodeCursor, encodeCursor, percentile } from './stats.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';

describe('stats helpers', () => {
  it('approximates percentiles from the histogram and round-trips cursors', () => {
    expect(percentile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.5)).toBeNull();
    expect(percentile([90, 9, 1, 0, 0, 0, 0, 0, 0, 0], 0.5)).toBe(100);
    expect(percentile([90, 9, 1, 0, 0, 0, 0, 0, 0, 0], 0.95)).toBe(250);
    const d = new Date('2026-11-07T10:00:00.123Z');
    expect(decodeCursor(encodeCursor(d, 'req_1'))).toEqual({ createdAt: d, id: 'req_1' });
    expect(() => decodeCursor('garbage')).toThrow();
  });
});

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('stats and logs over HTTP', () => {
  let app: NestFastifyApplication;
  let gateway: Server;
  let token = '';
  let viewer = '';
  let org = '';
  const hour = new Date();
  hour.setUTCMinutes(0, 0, 0);
  const at = (minutes: number) => new Date(hour.getTime() - 3_600_000 + minutes * 60_000);

  const call = (url: string, t = token) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/v1/orgs/${org}/${url}`,
        headers: { authorization: `Bearer ${t}` },
      });

  async function insertLogs(
    organizationId: string,
    n: number,
    opts: { created?: (i: number) => Date; model?: string; prefix?: string } = {},
  ) {
    const db = app.get(PrismaService).client;
    await db.requestLog.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        id: `${opts.prefix ?? organizationId}_${String(i).padStart(3, '0')}`,
        createdAt: opts.created?.(i) ?? at(i % 50),
        organizationId,
        projectId: 'prj_s',
        apiKeyId: i % 2 ? 'key_a' : 'key_b',
        inboundApi: 'openai.chat',
        requestedModel: opts.model ?? (i % 3 ? 'gpt-4.1' : 'claude'),
        providerId: 'prv_s',
        stream: false,
        status: i % 10 === 0 ? 'error' : 'success',
        httpStatus: i % 10 === 0 ? 502 : 200,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: '0.001',
        latencyMs: 80 + i,
        attempts: [{ providerId: 'prv_s', outcome: 'success' }],
        configVersion: 1,
        gatewayInstance: 'gw',
      })),
    });
  }

  beforeAll(async () => {
    gateway = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          providers: [
            { id: 'prv_mine', state: 'open', total: 12, errors: 9, reopensAt: Date.now() + 20_000 },
            { id: 'prv_foreign', state: 'open', total: 1, errors: 1 },
          ],
          models: [],
          credentials: [
            { credentialId: 'cred_mine', cooldownUntil: Date.now() + 5_000, lockouts: [] },
          ],
        }),
      );
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const ga = gateway.address();
    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: generateKey(),
      KEY_PEPPER: 'p'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
      GATEWAY_INTERNAL_URL: `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`,
    });
    app = await createApp(env);
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, budgets, api_keys, combo_targets, combos, model_aliases, credentials, models, providers, projects, teams, users, organizations, config_versions, request_log, usage_hourly, usage_daily RESTART IDENTITY CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    const inject = app.getHttpAdapter().getInstance();
    token = (
      await inject.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          organizationName: 'Stats Org',
          name: 'O',
          email: 'st@example.com',
          password: PW,
        },
      })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await inject.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json<{
        organizations: { id: string }[];
      }>().organizations[0]?.id ?? '';
    const inv = (
      await inject.inject({
        method: 'POST',
        url: `/api/v1/orgs/${org}/invitations`,
        headers: { authorization: `Bearer ${token}` },
        payload: { email: 'sv@example.com', role: 'VIEWER' },
      })
    ).json<{ token: string }>();
    viewer = (
      await inject.inject({
        method: 'POST',
        url: '/api/v1/auth/invitations/accept',
        payload: { token: inv.token, name: 'V', password: PW },
      })
    ).json<{
      accessToken: string;
    }>().accessToken;
    await db.organization.create({ data: { id: 'org_other', name: 'Other', slug: 'other' } });
    await db.provider.create({
      data: {
        id: 'prv_mine',
        organizationId: org,
        slug: 'mine',
        name: 'Mine',
        type: 'OPENAI',
        baseUrl: 'https://x',
      },
    });
    await db.credential.create({
      data: {
        id: 'cred_mine',
        providerId: 'prv_mine',
        name: 'k',
        secretEnc: 'v1.x',
        keyVersion: 1,
        last4: 'abcd',
      },
    });
    await insertLogs(org, 100);
    await insertLogs('org_other', 40, { model: 'secret-model' });
    // rollup همان ساعت‌ها (کاری که worker انجام می‌دهد).
    for (const h of [at(0), at(59)])
      await db.$queryRawUnsafe('SELECT dirouter_rollup_hour($1::timestamptz)', h.toISOString());
    for (const d of new Set([at(0), at(59)].map((x) => x.toISOString().slice(0, 10))))
      await db.$queryRawUnsafe('SELECT dirouter_rollup_day($1::date)', d);
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => gateway.close(r));
  });

  it('overview KPIs only count the caller organization', async () => {
    const res = await call(`stats/overview?from=${at(-60).toISOString()}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      requests: 100,
      errors: 10,
      errorRate: 0.1,
      inputTokens: 10_000,
      costUsd: '0.1',
      latencyP50Ms: 250,
    });
    expect((await call(`stats/overview?from=${at(-60).toISOString()}`, viewer)).statusCode).toBe(
      200,
    );
  });

  it('timeseries and top lists stay inside the organization', async () => {
    const series = (
      await call(`stats/timeseries?from=${at(-60).toISOString()}&granularity=hour`)
    ).json<{ points: { requests: number }[] }>();
    expect(series.points.reduce((n, p) => n + p.requests, 0)).toBe(100);
    const top = (
      await call(`stats/top?from=${at(-60).toISOString()}&by=model&metric=requests`)
    ).json<{ items: { id: string; requests: number }[] }>();
    expect(top.items.map((i) => i.id)).toEqual(['gpt-4.1', 'claude']);
    expect(JSON.stringify(top)).not.toContain('secret-model');
    const daily = (
      await call(`stats/timeseries?from=${at(-1440).toISOString()}&granularity=day`)
    ).json<{ points: { requests: number }[] }>();
    expect(daily.points.reduce((n, p) => n + p.requests, 0)).toBe(100);
  });

  it('cursor pagination is stable: no duplicates or gaps, even with ties and new rows arriving', async () => {
    // ۳۰ ردیف با created_at یکسان (tie) به‌اضافهٔ ۱۰۰ ردیف قبلی.
    await insertLogs(org, 30, { created: () => at(30), prefix: 'tie' });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(
        `logs?from=${at(-60).toISOString()}&limit=17${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const body = res.json<{
        items: { id: string; createdAt: string }[];
        nextCursor: string | null;
      }>();
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      // رسیدن ردیف تازه وسط صفحه‌بندی صفحه‌های بعدی را جابه‌جا نمی‌کند.
      if (pages++ === 1) await insertLogs(org, 5, { created: () => new Date(), prefix: 'fresh' });
    } while (cursor);
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
    expect(seen.some((id) => id.startsWith('org_other'))).toBe(false);
    const filtered = (
      await call(`logs?from=${at(-60).toISOString()}&status=error&limit=200`)
    ).json<{ items: { status: string }[] }>();
    expect(filtered.items.every((i) => i.status === 'error')).toBe(true);
  });

  it('log details include attempts, and other organizations get 404', async () => {
    const first =
      (await call(`logs?from=${at(-60).toISOString()}&limit=1`)).json<{ items: { id: string }[] }>()
        .items[0]?.id ?? '';
    const detail = await call(`logs/${first}`);
    expect(detail.json()).toMatchObject({ id: first, attempts: [{ providerId: 'prv_s' }] });
    expect((await call('logs/org_other_000')).statusCode).toBe(404);
    expect((await call('logs?cursor=broken')).statusCode).toBe(422);
  });

  it('runtime health shows only this organization providers and credentials', async () => {
    const res = (await call('health/runtime')).json<{
      gatewayReachable: boolean;
      providers: {
        id: string;
        breaker: { state: string };
        credentials: { cooldownUntil: string | null }[];
      }[];
    }>();
    expect(res.gatewayReachable).toBe(true);
    expect(res.providers.map((p) => p.id)).toEqual(['prv_mine']);
    expect(res.providers[0]?.breaker.state).toBe('open');
    expect(res.providers[0]?.credentials[0]?.cooldownUntil).toBeTruthy();
    expect(JSON.stringify(res)).not.toContain('prv_foreign');
  });
});
