/** End users over HTTP (card 33.2): limits and defaults, blocking, the snapshot, list and usage. */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('end users over HTTP', () => {
  let app: NestFastifyApplication;
  let org = '';
  let token = '';
  const call = (method: string, url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/orgs/${org}/${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

  beforeAll(async () => {
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, teams, budgets, rate_limit_policies, end_users, usage_dimension_daily, usage_dimension_hourly, change_requests, organizations CASCADE',
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const http = app.getHttpAdapter().getInstance();
    token = (
      await http.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          organizationName: 'SaaS',
          name: 'O',
          email: 'owner@eu.example.com',
          password: 'a-long-enough-password',
        },
      })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await http.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('sets the defaults of every end user and the limits of one, and blocks another', async () => {
    const defaults = await call('PUT', 'limits/end_user/*', {
      rpm: 20,
      budgets: [{ period: 'daily', limitUsd: '1' }],
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      scope: 'end_user',
      scopeId: '*',
      name: 'Every end user',
    });
    // An id with a slash or a pipe is still one end user.
    const own = await call('PUT', `limits/end_user/${encodeURIComponent('cust|42/a')}`, {
      budgets: [{ period: 'monthly', limitUsd: '50' }],
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ scopeId: 'cust|42/a', name: 'cust|42/a' });
    const blocked = await call('PUT', 'end-users/mallory', { blocked: true });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ id: 'mallory', blocked: true });
    // Something that can never be an end-user id is refused.
    expect((await call('PUT', 'end-users/%20', { blocked: true })).statusCode).toBe(404);
    expect((await call('PUT', `limits/end_user/${'x'.repeat(300)}`, { rpm: 1 })).statusCode).toBe(
      404,
    );

    const limits = (await app.get(SnapshotService).build()).limits ?? [];
    const mine = limits.filter((l) => l.organizationId === org && l.scope === 'end_user');
    expect(mine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeId: '*',
          rateLimit: { requestsPerMinute: 20 },
          budgets: [expect.objectContaining({ period: 'daily', limitUsd: '1' })],
        }),
        expect.objectContaining({
          scopeId: 'cust|42/a',
          budgets: [expect.objectContaining({ limitUsd: '50' })],
        }),
        { organizationId: org, scope: 'end_user', scopeId: 'mallory', budgets: [], blocked: true },
      ]),
    );
    // Unblocking removes it from the snapshot (it has no limits).
    await call('PUT', 'end-users/mallory', { blocked: false });
    expect(
      ((await app.get(SnapshotService).build()).limits ?? []).some((l) => l.scopeId === 'mallory'),
    ).toBe(false);
  });

  it('lists end users with this month’s usage and shows one with its days and limits', async () => {
    const db = app.get(PrismaService).client;
    const now = new Date();
    await db.endUser.createMany({
      data: [
        { id: 'eu_a', organizationId: org, externalId: 'alice', firstSeenAt: now, lastSeenAt: now },
        {
          id: 'eu_b',
          organizationId: org,
          externalId: 'bob',
          firstSeenAt: now,
          lastSeenAt: new Date(now.getTime() - 3_600_000),
        },
        // another organization's end user with the same id
        { id: 'eu_x', organizationId: 'org_someone_else', externalId: 'alice', lastSeenAt: now },
      ],
    });
    const day = now.toISOString().slice(0, 10);
    const row = (value: string, model: string, cost: string, organizationId = org) => ({
      bucket: new Date(`${day}T00:00:00.000Z`),
      organizationId,
      dimension: 'end_user',
      value,
      projectId: 'prj',
      apiKeyId: 'key',
      modelSlug: model,
      providerId: 'p',
      requests: 2,
      inputTokens: 10n,
      outputTokens: 5n,
      costUsd: cost,
      chargeUsd: cost,
    });
    await db.usageDimensionDaily.createMany({
      data: [
        row('alice', 'gpt-big', '3'),
        row('alice', 'gpt-small', '0.5'),
        row('bob', 'gpt-small', '1'),
        row('alice', 'gpt-big', '99', 'org_someone_else'),
      ],
    });
    await db.usageDimensionHourly.createMany({
      data: [
        { ...row('alice', 'gpt-big', '3'), bucket: new Date(now.getTime() - 60_000) },
        { ...row('bob', 'gpt-small', '1'), bucket: new Date(now.getTime() - 60_000) },
      ].map((r) => ({
        ...r,
        bucket: new Date(Math.floor(r.bucket.getTime() / 3_600_000) * 3_600_000),
      })),
    });

    const list = (await call('GET', 'end-users')).json<{
      total: number;
      items: {
        id: string;
        month: { requests: number; costUsd: string };
        hasLimits: boolean;
        blocked: boolean;
      }[];
    }>();
    expect(list.items.map((i) => i.id).slice(0, 2)).toEqual(['alice', 'bob']);
    expect(list.items.find((i) => i.id === 'alice')?.month).toEqual({
      requests: 4,
      costUsd: '3.5',
    });
    expect(list.items.find((i) => i.id === 'cust|42/a')?.hasLimits).toBe(true);
    expect((await call('GET', 'end-users?search=ALI')).json<{ total: number }>().total).toBe(1);
    expect((await call('GET', 'end-users?blocked=true')).json<{ total: number }>().total).toBe(0);

    const alice = (await call('GET', 'end-users/alice')).json<{
      month: { costUsd: string };
      days: { day: string; costUsd: string; requests: number }[];
      limits: { scope: string; budgets: unknown[] };
    }>();
    expect(alice.days).toEqual([{ day, requests: 4, errors: 0, tokens: 30, costUsd: '3.5' }]);
    expect(alice.limits).toMatchObject({ scope: 'end_user', budgets: [] });
    expect((await call('GET', 'end-users/nobody')).statusCode).toBe(404);

    // Analytics per end user: by value, and one end user's usage by model.
    const from = new Date(now.getTime() - 86_400_000).toISOString();
    const byUser = (await call('GET', `stats/dimensions?dimension=end_user&from=${from}`)).json<{
      items: { id: string; costUsd: string }[];
    }>();
    expect(byUser.items).toEqual([
      expect.objectContaining({ id: 'alice', costUsd: '3' }),
      expect.objectContaining({ id: 'bob', costUsd: '1' }),
    ]);
    const analytics = (await call('GET', `stats/analytics?from=${from}`)).json<{
      byEndUser: { items: { id: string }[] };
    }>();
    expect(analytics.byEndUser.items.map((i) => i.id)).toEqual(['alice', 'bob']);
    const aliceByModel = (
      await call(
        'GET',
        `stats/dimensions?dimension=end_user&value=alice&groupBy=model&from=${from}`,
      )
    ).json<{ items: { id: string }[] }>();
    expect(aliceByModel.items.map((i) => i.id)).toEqual(['gpt-big']);
  });
});
