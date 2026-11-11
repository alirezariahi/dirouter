/** Virtual keys against real Postgres and Valkey, over HTTP (card 3.7). */
import { generateKey, hashApiKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';
const PEPPER = 'q'.repeat(32);

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('virtual keys over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let viewer = '';
  let member = '';
  let org = '';
  let project = '';
  let key = { id: '', key: '' };

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    t = token,
    body?: unknown,
  ) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        remoteAddress: '10.7.0.1',
        headers: t ? { authorization: `Bearer ${t}` } : {},
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const join = async (email: string, role: string) => {
    const inv = (await call('POST', `orgs/${org}/invitations`, token, { email, role })).json<{
      token: string;
    }>();
    return (
      await call('POST', 'auth/invitations/accept', '', {
        token: inv.token,
        name: email,
        password: PW,
      })
    ).json<{
      accessToken: string;
    }>().accessToken;
  };

  beforeAll(async () => {
    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: generateKey(),
      KEY_PEPPER: PEPPER,
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
    });
    app = await createApp(env);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, budgets, api_keys, credentials, models, providers, projects, teams, users, organizations CASCADE',
      );
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    token = (
      await call('POST', 'auth/setup', '', {
        organizationName: 'Keys Org',
        name: 'O',
        email: 'k@example.com',
        password: PW,
      })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (await call('GET', 'auth/me')).json<{ organizations: { id: string }[] }>().organizations[0]
        ?.id ?? '';
    project = (await call('POST', `orgs/${org}/projects`, token, { name: 'Prod' })).json<{
      id: string;
    }>().id;
    viewer = await join('kv@example.com', 'VIEWER');
    member = await join('km@example.com', 'MEMBER');
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows the full key exactly once and stores only its HMAC', async () => {
    const res = await call('POST', `orgs/${org}/keys`, token, {
      name: 'backend',
      projectId: project,
      allowedModels: ['gpt-4.1'],
      ipAllowlist: ['10.0.0.0/8', '2001:db8::1'],
      rpm: 600,
      budgets: [{ period: 'monthly', limitUsd: '50' }],
    });
    expect(res.statusCode).toBe(201);
    key = res.json<{ id: string; key: string }>();
    expect(key.key).toMatch(/^dr-[a-z2-9]{8}-[a-z2-9]{40}$/);
    expect(res.json()).toMatchObject({
      state: 'active',
      rpm: 600,
      budgets: [{ period: 'monthly', limitUsd: '50' }],
    });
    const secretPart = key.key.split('-')[2] ?? '';
    for (const r of [
      await call('GET', `orgs/${org}/keys`),
      await call('GET', `orgs/${org}/keys/${key.id}`),
    ]) {
      expect(r.body).not.toContain(secretPart);
      expect(r.body).not.toContain('"key"');
    }
    const db = app.get(PrismaService).client;
    const row = await db.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.hash).toBe(hashApiKey(key.key, PEPPER));
    expect(key.key.startsWith(`${row.prefix}-`)).toBe(true);
    // The raw key is not in any table.
    const dump = JSON.stringify(
      [await db.apiKey.findMany(), await db.auditLog.findMany(), await db.budget.findMany()],
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    expect(dump).not.toContain(secretPart);
  });

  it('updates limits and rejects bad IPs, past expiry and foreign projects', async () => {
    const up = await call('PATCH', `orgs/${org}/keys/${key.id}`, token, {
      tpm: 100000,
      allowedModels: [],
    });
    expect(up.json()).toMatchObject({ tpm: 100000, allowedModels: [] });
    expect(
      (await call('PATCH', `orgs/${org}/keys/${key.id}`, token, { ipAllowlist: ['10.0.0.0/33'] }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call('PATCH', `orgs/${org}/keys/${key.id}`, token, {
          expiresAt: '2020-01-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('POST', `orgs/${org}/keys`, token, {
          name: 'x',
          projectId: 'prj_of_someone_else',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rotation keeps the old key valid until the grace period ends and copies its settings', async () => {
    const before = Date.now();
    const res = await call('POST', `orgs/${org}/keys/${key.id}/rotate`, token, {
      graceSeconds: 3600,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      key: string;
      state: string;
      tpm: number;
      budgets: unknown[];
      previous: { state: string; expiresAt: string; rotatedToId: string };
    }>();
    expect(body.key).not.toBe(key.key);
    expect(body).toMatchObject({ state: 'active', tpm: 100000 });
    expect(body.budgets).toHaveLength(1);
    expect(body.previous).toMatchObject({ state: 'rotating', rotatedToId: body.id });
    const graceEnd = Date.parse(body.previous.expiresAt);
    expect(graceEnd).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(graceEnd).toBeLessThanOrEqual(Date.now() + 3_600_000);
    expect((await call('POST', `orgs/${org}/keys/${key.id}/rotate`, token, {})).statusCode).toBe(
      409,
    );
    key = body;
  });

  it('revocation is immediate in the database and blocks rotation', async () => {
    const res = await call('POST', `orgs/${org}/keys/${key.id}/revoke`, token);
    expect(res.json()).toMatchObject({ state: 'revoked' });
    expect(res.json<{ revokedAt: string }>().revokedAt).toBeTruthy();
    expect((await call('POST', `orgs/${org}/keys/${key.id}/rotate`, token, {})).statusCode).toBe(
      409,
    );
  });

  it('members create keys, viewers only read', async () => {
    expect(
      (await call('POST', `orgs/${org}/keys`, member, { name: 'm', projectId: project }))
        .statusCode,
    ).toBe(201);
    expect((await call('GET', `orgs/${org}/keys`, viewer)).statusCode).toBe(200);
    expect(
      (await call('POST', `orgs/${org}/keys`, viewer, { name: 'v', projectId: project }))
        .statusCode,
    ).toBe(403);
    expect((await call('POST', `orgs/${org}/keys/${key.id}/revoke`, viewer)).statusCode).toBe(403);
  });
});
