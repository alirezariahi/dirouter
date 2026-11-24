/**
 * Request bodies over HTTP against real Postgres and Valkey (card 24.1): the `logs:bodies`
 * permission, organization isolation, capture levels reaching the snapshot, and the stored payload
 * with its replay draft.
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

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('request bodies over HTTP', () => {
  let app: NestFastifyApplication;
  let owner = '';
  let viewer = '';
  let org = '';
  const created = new Date(Date.now() - 60_000);

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

  const body = (requestId: string, organizationId: string) => ({
    requestId,
    createdAt: created,
    organizationId,
    projectId: 'prj_b',
    apiKeyId: 'key_b',
    inboundApi: 'openai.chat',
    level: 'full',
    metadata: { model: 'gpt', messages: 1, roles: { user: 1 }, parameters: [], tools: [] },
    request: '{"model":"gpt","messages":[{"role":"user","content":"mail [REDACTED]"}]}',
    response: '{"choices":[{"message":{"content":"ok"}}]}',
    redactions: 1,
    replay: { history: [], prompt: 'mail [REDACTED]', lossy: false },
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
      'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, api_keys, projects, teams, users, organizations, config_versions, request_log, request_bodies, body_capture_settings RESTART IDENTITY CASCADE',
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
          organizationName: 'Bodies Org',
          name: 'O',
          email: 'bo@example.com',
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
        payload: { email: 'bv@example.com', role: 'VIEWER' },
      })
    ).json<{ token: string }>();
    viewer = (
      await inject.inject({
        method: 'POST',
        url: '/api/v1/auth/invitations/accept',
        payload: { token: inv.token, name: 'V', password: PW },
      })
    ).json<{ accessToken: string }>().accessToken;

    await db.organization.create({ data: { id: 'org_other_b', name: 'Other', slug: 'other-b' } });
    await db.project.createMany({
      data: [
        { id: 'prj_b', organizationId: org, name: 'P', slug: 'p' },
        { id: 'prj_foreign', organizationId: 'org_other_b', name: 'F', slug: 'f' },
      ],
    });
    await db.$executeRawUnsafe('SELECT dirouter_ensure_request_log_partitions(3)');
    await db.requestLog.create({
      data: {
        id: 'req_body_1',
        createdAt: created,
        organizationId: org,
        projectId: 'prj_b',
        apiKeyId: 'key_b',
        inboundApi: 'openai.chat',
        requestedModel: 'gpt',
        stream: false,
        status: 'success',
        httpStatus: 200,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: '0',
        latencyMs: 10,
        configVersion: 1,
        gatewayInstance: 'gw',
      },
    });
    await db.requestBody.createMany({
      data: [body('req_body_1', org), body('req_body_foreign', 'org_other_b')],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('is closed to roles without logs:bodies, even when they can read logs', async () => {
    expect((await call('GET', 'logs/req_body_1', viewer)).statusCode).toBe(200);
    expect((await call('GET', 'logs/req_body_1/body', viewer)).statusCode).toBe(403);
    expect((await call('GET', 'body-capture', viewer)).statusCode).toBe(403);
    expect(
      (
        await call('PUT', 'body-capture', viewer, {
          scope: 'organization',
          scopeId: org,
          level: 'full',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('returns the stored, redacted payload and its replay draft', async () => {
    const res = await call('GET', 'logs/req_body_1/body', owner);
    expect(res.statusCode).toBe(200);
    const stored = res.json<{
      level: string;
      request: string;
      redactions: number;
      replay: { prompt: string };
    }>();
    expect(stored.level).toBe('full');
    expect(stored.request).toContain('[REDACTED]');
    expect(stored.redactions).toBe(1);
    expect(stored.replay.prompt).toBe('mail [REDACTED]');
  });

  it("never returns another organization's body or one that was not captured", async () => {
    expect((await call('GET', 'logs/req_body_foreign/body', owner)).statusCode).toBe(404);
    expect((await call('GET', 'logs/req_missing/body', owner)).statusCode).toBe(404);
  });

  it('is off by default and sets, lists and clears levels that reach the snapshot', async () => {
    const initial = (await call('GET', 'body-capture', owner)).json<{
      defaultLevel: string;
      rules: unknown[];
    }>();
    expect(initial).toMatchObject({ defaultLevel: 'none', rules: [] });
    const snapshots = app.get(SnapshotService);
    expect((await snapshots.build()).bodyCapture).toBeUndefined();

    const set = await call('PUT', 'body-capture', owner, {
      scope: 'project',
      scopeId: 'prj_b',
      level: 'full',
    });
    expect(set.statusCode).toBe(200);
    expect(set.json<{ configVersion: number }>().configVersion).toBeGreaterThan(0);
    await call('PUT', 'body-capture', owner, {
      scope: 'organization',
      scopeId: org,
      level: 'metadata',
    });
    const listed = (await call('GET', 'body-capture', owner)).json<{
      rules: { scope: string; scopeId: string; level: string }[];
    }>();
    expect(listed.rules.map((r) => [r.scope, r.scopeId, r.level])).toEqual([
      ['organization', org, 'metadata'],
      ['project', 'prj_b', 'full'],
    ]);
    expect((await snapshots.build()).bodyCapture).toEqual([
      { organizationId: org, scope: 'organization', scopeId: org, level: 'metadata' },
      { organizationId: org, scope: 'project', scopeId: 'prj_b', level: 'full' },
    ]);

    await call('PUT', 'body-capture', owner, {
      scope: 'project',
      scopeId: 'prj_b',
      level: 'inherit',
    });
    expect(
      (await call('GET', 'body-capture', owner)).json<{ rules: unknown[] }>().rules,
    ).toHaveLength(1);
    const audit = await app
      .get(PrismaService)
      .client.auditLog.count({ where: { organizationId: org, action: 'body_capture.updated' } });
    expect(audit).toBe(3);
  });

  it('refuses scopes outside the organization', async () => {
    for (const payload of [
      { scope: 'project', scopeId: 'prj_foreign', level: 'full' },
      { scope: 'organization', scopeId: 'org_other_b', level: 'full' },
      { scope: 'key', scopeId: 'key_nowhere', level: 'full' },
    ])
      expect((await call('PUT', 'body-capture', owner, payload)).statusCode).toBe(404);
    expect(
      (
        await call('PUT', 'body-capture', owner, {
          scope: 'project',
          scopeId: 'prj_b',
          level: 'all',
        })
      ).statusCode,
    ).toBe(422);
  });
});
