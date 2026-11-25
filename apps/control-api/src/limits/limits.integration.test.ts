/** Team and project limits: CRUD, snapshot, usage and four-eyes approval (card 25.5). */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../auth/crypto.js';
import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

interface Limit {
  scope: string;
  scopeId: string;
  name: string;
  rpm: number | null;
  tpm: number | null;
  maxConcurrency: number | null;
  budgets: {
    id: string;
    period: string;
    limitUsd: string | null;
    limitTokens: number | null;
    alertThresholds: number[];
  }[];
}

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('team and project limits over HTTP', () => {
  let app: NestFastifyApplication;
  let org = '';
  let team = '';
  let project = '';
  let other = '';
  const tokens: Record<string, string> = {};
  const as = (who: string, method: string, url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/orgs/${org}/${url}`,
        headers: { authorization: `Bearer ${tokens[who] ?? ''}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const call = (method: string, url: string, body?: unknown) => as('owner', method, url, body);
  const member = async (name: string, role: 'ADMIN' | 'VIEWER' | 'MEMBER') => {
    const db = app.get(PrismaService).client;
    const id = `usr_lim_${name}`;
    await db.user.create({
      data: {
        id,
        email: `${name}@lim.example.com`,
        name,
        passwordHash: await hashPassword('a-long-enough-password'),
      },
    });
    await db.membership.create({
      data: { id: `mem_lim_${name}`, userId: id, organizationId: org, role },
    });
    tokens[name] = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: `${name}@lim.example.com`, password: 'a-long-enough-password' },
        })
    ).json<{ accessToken: string }>().accessToken;
  };

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
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, teams, budgets, rate_limit_policies, usage_ledger, change_requests, organizations CASCADE',
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    tokens.owner = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'Limits',
            name: 'O',
            email: 'owner@lim.example.com',
            password: 'a-long-enough-password',
          },
        })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: { authorization: `Bearer ${tokens.owner}` },
          })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
    team = (await call('POST', 'teams', { name: 'Platform' })).json<{ id: string }>().id;
    project = (await call('POST', 'projects', { name: 'Search', teamId: team })).json<{
      id: string;
    }>().id;
    other = (await call('POST', 'projects', { name: 'Billing' })).json<{ id: string }>().id;
    await member('admin', 'ADMIN');
    await member('viewer', 'VIEWER');
    await member('member', 'MEMBER');
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets a project budget and rate limit, and the snapshot carries them for the gateway', async () => {
    const res = await call('PUT', `limits/project/${project}`, {
      rpm: 60,
      maxConcurrency: 4,
      budgets: [{ period: 'monthly', limitUsd: '25.5', alertThresholds: [80, 100] }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Limit>()).toMatchObject({
      scope: 'project',
      scopeId: project,
      name: 'Search',
      rpm: 60,
      tpm: null,
      maxConcurrency: 4,
      budgets: [
        { period: 'monthly', limitUsd: '25.5', limitTokens: null, alertThresholds: [80, 100] },
      ],
    });
    const snapshot = await app.get(SnapshotService).build();
    expect(snapshot.limits).toContainEqual({
      organizationId: org,
      scope: 'project',
      scopeId: project,
      rateLimit: { requestsPerMinute: 60, maxConcurrency: 4 },
      budgets: [
        expect.objectContaining({
          period: 'monthly',
          limitUsd: '25.5',
          alertThresholds: [80, 100],
        }),
      ],
    });
    // The project's keys get their team id in the snapshot, so team limits apply to them too.
    const teamRes = await call('PUT', `limits/team/${team}`, {
      budgets: [{ period: 'daily', limitTokens: 1_000_000 }],
    });
    expect(teamRes.statusCode).toBe(200);
    expect((await app.get(SnapshotService).build()).limits).toContainEqual(
      expect.objectContaining({
        scope: 'team',
        scopeId: team,
        budgets: [expect.objectContaining({ period: 'daily', limitTokens: 1_000_000 })],
      }),
    );
  });

  it('keeps the budget id (and so the running counter) when the amount changes', async () => {
    const before = (await call('GET', `limits/project/${project}`)).json<Limit>().budgets[0]?.id;
    const changed = await call('PUT', `limits/project/${project}`, {
      budgets: [{ period: 'monthly', limitUsd: '30' }],
    });
    expect(changed.json<Limit>().budgets).toEqual([
      {
        id: before,
        period: 'monthly',
        limitUsd: '30',
        limitTokens: null,
        alertThresholds: [50, 80, 100],
      },
    ]);
    // Rate limits not in the body stay as they were.
    expect(changed.json<Limit>()).toMatchObject({ rpm: 60, maxConcurrency: 4 });
    // Clearing every rate limit removes the policy; the budget stays.
    const cleared = await call('PUT', `limits/project/${project}`, {
      rpm: null,
      maxConcurrency: null,
    });
    expect(cleared.json<Limit>()).toMatchObject({ rpm: null, tpm: null, maxConcurrency: null });
    expect(cleared.json<Limit>().budgets).toHaveLength(1);
  });

  it('lists the teams and projects with limits; validates and scopes every write', async () => {
    const list = (await call('GET', 'limits')).json<Limit[]>();
    expect(list.map((l) => `${l.scope}:${l.name}`)).toEqual(['project:Search', 'team:Platform']);
    expect(
      (
        await call('PUT', `limits/project/${project}`, {
          budgets: [
            { period: 'monthly', limitUsd: '1' },
            { period: 'monthly', limitUsd: '2' },
          ],
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call('PUT', `limits/project/${project}`, { budgets: [{ period: 'daily' }] }))
        .statusCode,
    ).toBe(422);
    expect((await call('PUT', `limits/project/${project}`, { rpm: 0 })).statusCode).toBe(422);
    expect((await call('PUT', 'limits/project/prj_of_someone_else', { rpm: 5 })).statusCode).toBe(
      404,
    );
    expect((await call('PUT', `limits/org/${project}`, { rpm: 5 })).statusCode).toBe(422);
    // Reading needs org:read; writing needs org:write (members and viewers cannot).
    expect((await as('viewer', 'GET', 'limits')).statusCode).toBe(200);
    expect((await as('viewer', 'PUT', `limits/project/${other}`, { rpm: 5 })).statusCode).toBe(403);
    expect((await as('member', 'PUT', `limits/project/${other}`, { rpm: 5 })).statusCode).toBe(403);
  });

  it('reports what every team and project spent today and this month', async () => {
    const db = app.get(PrismaService).client;
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const entry = (id: string, projectId: string, teamId: string | null, usd: string, at: Date) =>
      db.usageLedger.create({
        data: {
          id,
          requestId: `req_${id}`,
          organizationId: org,
          teamId,
          projectId,
          apiKeyId: 'key_x',
          costUsd: usd,
          tokens: 1000,
          occurredAt: at,
        },
      });
    await entry('l1', project, team, '12', now);
    await entry('l2', project, team, '3', now);
    await entry('l3', other, null, '1.25', now);
    await entry('l4', project, team, '100', lastMonth);
    const usage = (await call('GET', 'limits/usage')).json<{
      scopes: {
        scope: string;
        scopeId: string;
        today: { usd: string; tokens: number };
        month: { usd: string; tokens: number };
        rateLimit: unknown;
        budgets: { period: string; spentUsd: string; usedPercent: number | null }[];
      }[];
    }>();
    const search = usage.scopes.find((s) => s.scopeId === project);
    expect(Number(search?.month.usd)).toBe(15);
    expect(search?.month.tokens).toBe(2000);
    expect(Number(search?.today.usd)).toBe(15);
    expect(search?.budgets).toEqual([
      expect.objectContaining({ period: 'monthly', limitUsd: '30', usedPercent: 50 }),
    ]);
    const platform = usage.scopes.find((s) => s.scopeId === team);
    expect(Number(platform?.month.usd)).toBe(15);
    expect(platform?.budgets[0]).toMatchObject({ period: 'daily', usedPercent: 0.2 });
    // A project without limits is listed with its spend.
    const billing = usage.scopes.find((s) => s.scopeId === other);
    expect(Number(billing?.month.usd)).toBe(1.25);
    expect(billing?.budgets).toEqual([]);
    expect(billing?.rateLimit).toBeNull();
    expect((await as('viewer', 'GET', 'limits/usage')).statusCode).toBe(200);
  });

  it('with four-eyes, a budget change waits for a second person; a rate change does not', async () => {
    await call('PATCH', 'security', { changeApprovalRequired: true });
    const rate = await call('PUT', `limits/project/${project}`, { rpm: 120 });
    expect(rate.statusCode).toBe(200);
    // Sending the same budgets again is not a budget change either.
    const same = await call('PUT', `limits/project/${project}`, {
      rpm: 100,
      budgets: [{ period: 'monthly', limitUsd: '30.00' }],
    });
    expect(same.statusCode).toBe(200);

    const asked = await call('PUT', `limits/project/${project}`, {
      budgets: [{ period: 'monthly', limitUsd: '0.5' }],
    });
    expect(asked.statusCode).toBe(202);
    const request = asked.json<{ changeRequest: { id: string; summary: string } }>().changeRequest;
    expect(request.summary).toBe('Change the budgets of project Search');
    expect(
      (await call('GET', `limits/project/${project}`)).json<Limit>().budgets[0]?.limitUsd,
    ).toBe('30');
    expect((await as('admin', 'POST', `change-requests/${request.id}/approve`)).statusCode).toBe(
      200,
    );
    expect(
      (await call('GET', `limits/project/${project}`)).json<Limit>().budgets[0]?.limitUsd,
    ).toBe('0.5');

    // Removing limits with a budget is a budget change too.
    const removed = await call('DELETE', `limits/project/${project}`);
    expect(removed.statusCode).toBe(202);
    await as(
      'admin',
      'POST',
      `change-requests/${removed.json<{ changeRequest: { id: string } }>().changeRequest.id}/approve`,
    );
    expect((await call('GET', `limits/project/${project}`)).json<Limit>()).toMatchObject({
      rpm: null,
      budgets: [],
    });
    await call('PATCH', 'security', { changeApprovalRequired: false });
  });
});
