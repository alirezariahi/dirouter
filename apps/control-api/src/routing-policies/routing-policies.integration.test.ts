/**
 * Routing policies over HTTP against real Postgres and Valkey (card 32.1): only administrators
 * set them, scopes stay inside the organization, and they reach the gateway snapshot.
 */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('routing policies over HTTP', () => {
  let app: NestFastifyApplication;
  let owner = '';
  let member = '';
  let org = '';

  const call = (method: 'GET' | 'PUT', url: string, token: string, payload?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/orgs/${org}/${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      });

  beforeAll(async () => {
    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: generateKey(),
      KEY_PEPPER: 'p'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
      GATEWAY_INTERNAL_URL: 'http://127.0.0.1:9',
    });
    app = await createApp(env);
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, api_keys, projects, teams, users, organizations, config_versions, routing_policies RESTART IDENTITY CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    const inject = app.getHttpAdapter().getInstance();
    owner = (
      await inject.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          organizationName: 'Routing Org',
          name: 'O',
          email: 'ro@example.com',
          password: PW,
        },
      })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await inject.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${owner}` },
        })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
    const inv = (
      await inject.inject({
        method: 'POST',
        url: `/api/v1/orgs/${org}/invitations`,
        headers: { authorization: `Bearer ${owner}` },
        payload: { email: 'rm@example.com', role: 'MEMBER' },
      })
    ).json<{ token: string }>();
    member = (
      await inject.inject({
        method: 'POST',
        url: '/api/v1/auth/invitations/accept',
        payload: { token: inv.token, name: 'M', password: PW },
      })
    ).json<{ accessToken: string }>().accessToken;
    await db.organization.create({ data: { id: 'org_other_r', name: 'Other', slug: 'other-r' } });
    await db.project.createMany({
      data: [
        { id: 'prj_r', organizationId: org, name: 'P', slug: 'p' },
        { id: 'prj_foreign_r', organizationId: 'org_other_r', name: 'F', slug: 'f' },
      ],
    });
    await db.apiKey.create({
      data: {
        id: 'key_r',
        organizationId: org,
        projectId: 'prj_r',
        name: 'k',
        prefix: 'dr-routing1',
        hash: 'b'.repeat(64),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const locked = {
    scope: 'key',
    scopeId: 'key_r',
    policy: { provider: { order: ['openai'], maxPrice: { prompt: 2 } }, lockProvider: true },
  };

  it('a member with keys:write cannot set or unlock a policy', async () => {
    expect((await call('PUT', 'routing-policies', member, locked)).statusCode).toBe(403);
    expect((await call('GET', 'routing-policies', member)).statusCode).toBe(200);
  });

  it('sets a locked key policy that reaches the snapshot, and removes it', async () => {
    const snapshots = app.get(SnapshotService);
    expect((await snapshots.build()).routingPolicies).toBeUndefined();
    const set = await call('PUT', 'routing-policies', owner, locked);
    expect(set.statusCode).toBe(200);
    expect(set.json<{ configVersion: number }>().configVersion).toBeGreaterThan(0);
    expect((await snapshots.build()).routingPolicies).toEqual([
      { organizationId: org, ...locked.policy, scope: 'key', scopeId: 'key_r' },
    ]);
    const listed = (await call('GET', 'routing-policies', owner)).json<{
      policies: { scope: string; policy: unknown }[];
    }>();
    expect(listed.policies).toMatchObject([{ scope: 'key', policy: locked.policy }]);

    expect(
      (await call('PUT', 'routing-policies', owner, { ...locked, policy: null })).statusCode,
    ).toBe(200);
    expect((await snapshots.build()).routingPolicies).toBeUndefined();
  });

  it('rejects invalid policies and scopes of another organization', async () => {
    expect(
      (
        await call('PUT', 'routing-policies', owner, {
          ...locked,
          policy: { provider: { sort: 'fastest' } },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('PUT', 'routing-policies', owner, {
          scope: 'project',
          scopeId: 'prj_foreign_r',
          policy: { lockProvider: true },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call('PUT', 'routing-policies', owner, {
          scope: 'organization',
          scopeId: 'org_other_r',
          policy: { lockProvider: true },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('carries the data policy and the explanation permission to the snapshot (cards 32.5, 32.7)', async () => {
    const policy = { dataPolicy: { requireZdr: true, allowedRegions: ['eu'] }, explain: true };
    const set = await call('PUT', 'routing-policies', owner, {
      scope: 'organization',
      scopeId: org,
      policy,
    });
    expect(set.statusCode).toBe(200);
    expect((await app.get(SnapshotService).build()).routingPolicies).toEqual([
      { organizationId: org, scope: 'organization', scopeId: org, ...policy },
    ]);
    await call('PUT', 'routing-policies', owner, {
      scope: 'organization',
      scopeId: org,
      policy: null,
    });
  });
});
