/**
 * Tags and cost centers over HTTP (card 33.4): on keys and in the snapshot, budgets per tag and cost
 * center, and usage per tag in analytics, filtered to one tag and grouped by model.
 */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('tags and cost centers over HTTP', () => {
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
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, teams, budgets, rate_limit_policies, usage_ledger, usage_dimension_daily, usage_dimension_hourly, change_requests, organizations CASCADE',
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const http = app.getHttpAdapter().getInstance();
    token = (
      await http.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          organizationName: 'Tagged',
          name: 'O',
          email: 'owner@tags.example.com',
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

  it('keys carry default tags and a cost center into the snapshot', async () => {
    const project = (await call('POST', 'projects', { name: 'P' })).json<{ id: string }>().id;
    const created = await call('POST', 'keys', {
      name: 'tagged',
      projectId: project,
      tags: ['team:ads', 'prod'],
      costCenter: 'cc-42',
    });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ id: string; tags: string[]; costCenter: string | null }>();
    expect(key).toMatchObject({ tags: ['team:ads', 'prod'], costCenter: 'cc-42' });
    const vk = (await app.get(SnapshotService).build()).virtualKeys.find((k) => k.id === key.id);
    expect(vk).toMatchObject({ tags: ['team:ads', 'prod'], costCenter: 'cc-42' });
    expect((await call('PATCH', `keys/${key.id}`, { tags: ['bad tag'] })).statusCode).toBe(422);
    expect((await call('PATCH', `keys/${key.id}`, { tags: ['a', 'a'] })).statusCode).toBe(422);
    const cleared = await call('PATCH', `keys/${key.id}`, { tags: [], costCenter: null });
    expect(cleared.json()).toMatchObject({ tags: [], costCenter: null });
  });

  it('budgets per tag and per cost center, within the organization', async () => {
    const tag = await call('PUT', 'limits/tag/team:ads', {
      budgets: [{ period: 'monthly', limitUsd: '100' }],
    });
    expect(tag.statusCode).toBe(200);
    expect(tag.json()).toMatchObject({ scope: 'tag', scopeId: 'team:ads', name: 'team:ads' });
    expect((await call('PUT', 'limits/cost_center/cc-42', { rpm: 100 })).json()).toMatchObject({
      scope: 'cost_center',
      rpm: 100,
    });
    expect(
      (await call('PUT', `limits/tag/${encodeURIComponent('no spaces')}`, { rpm: 1 })).statusCode,
    ).toBe(404);
    const limits = ((await app.get(SnapshotService).build()).limits ?? []).filter(
      (l) => l.organizationId === org,
    );
    expect(limits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'tag', scopeId: 'team:ads' }),
        expect.objectContaining({ scope: 'cost_center', scopeId: 'cc-42' }),
      ]),
    );
    // Usage of the tag from the ledger, a request with two tags counting for each.
    const db = app.get(PrismaService).client;
    await db.usageLedger.create({
      data: {
        id: 'led_tag_1',
        requestId: 'req_tag_1',
        organizationId: org,
        projectId: 'prj',
        apiKeyId: 'key',
        tags: ['team:ads', 'prod'],
        costCenter: 'cc-42',
        costUsd: '25',
        tokens: 10,
        occurredAt: new Date(),
      },
    });
    const usage = (await call('GET', 'limits/usage')).json<{
      scopes: {
        scope: string;
        scopeId: string;
        month: { usd: string };
        budgets: { usedPercent: number }[];
      }[];
    }>();
    const ads = usage.scopes.find((s) => s.scope === 'tag' && s.scopeId === 'team:ads');
    expect(Number(ads?.month.usd)).toBe(25);
    expect(ads?.budgets[0]?.usedPercent).toBe(25);
    expect(Number(usage.scopes.find((s) => s.scope === 'cost_center')?.month.usd)).toBe(25);
  });

  it('analytics by tag and cost center, and one tag by model', async () => {
    const db = app.get(PrismaService).client;
    const now = new Date();
    const day = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const row = (dimension: string, value: string, model: string, cost: string) => ({
      bucket: day,
      organizationId: org,
      dimension,
      value,
      projectId: 'prj',
      apiKeyId: 'key',
      modelSlug: model,
      providerId: 'p',
      requests: 1,
      costUsd: cost,
      chargeUsd: cost,
    });
    await db.usageDimensionDaily.createMany({
      data: [
        row('tag', 'team:ads', 'gpt-big', '5'),
        row('tag', 'team:ads', 'gpt-small', '1'),
        row('tag', 'prod', 'gpt-small', '2'),
        row('cost_center', 'cc-42', 'gpt-big', '5'),
      ],
    });
    // Over 7 days the daily table is read.
    const from = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    const analytics = (await call('GET', `stats/analytics?from=${from}&granularity=day`)).json<{
      byTag: { items: { id: string; costUsd: string }[] };
      byCostCenter: { items: { id: string }[] };
    }>();
    expect(analytics.byTag.items).toEqual([
      expect.objectContaining({ id: 'team:ads', costUsd: '6' }),
      expect.objectContaining({ id: 'prod', costUsd: '2' }),
    ]);
    expect(analytics.byCostCenter.items.map((i) => i.id)).toEqual(['cc-42']);
    const adsByModel = (
      await call(
        'GET',
        `stats/dimensions?dimension=tag&value=${encodeURIComponent('team:ads')}&groupBy=model&from=${from}`,
      )
    ).json<{ items: { id: string; costUsd: string }[] }>();
    expect(adsByModel.items.map((i) => [i.id, i.costUsd])).toEqual([
      ['gpt-big', '5'],
      ['gpt-small', '1'],
    ]);
  });
});
