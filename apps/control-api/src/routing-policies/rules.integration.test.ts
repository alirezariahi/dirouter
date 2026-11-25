/** Routing policies over HTTP (sprint 5): rules (32.2). */
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

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('routing policies over HTTP', () => {
  let app: NestFastifyApplication;
  let org = '';
  let otherOrg = '';
  let team = '';
  const tokens: Record<string, string> = {};
  const db = () => app.get(PrismaService).client;
  const inject = (token: string, method: string, url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const call = (method: string, url: string, body?: unknown) =>
    inject(tokens.owner ?? '', method, `orgs/${org}/${url}`, body);
  const login = async (email: string) =>
    (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: 'a-long-enough-password' },
        })
    ).json<{ accessToken: string }>().accessToken;
  const member = async (name: string, role: 'ADMIN' | 'VIEWER' | 'MEMBER') => {
    const id = `usr_rp_${name}`;
    await db().user.create({
      data: {
        id,
        email: `${name}@rp.example.com`,
        name,
        passwordHash: await hashPassword('a-long-enough-password'),
      },
    });
    await db().membership.create({
      data: { id: `mem_rp_${name}`, userId: id, organizationId: org, role },
    });
    tokens[name] = await login(`${name}@rp.example.com`);
  };
  const addModel = async (organizationId: string, slug: string, price: string) => {
    const providerId = `prv_rp_${organizationId}`;
    await db().provider.upsert({
      where: { id: providerId },
      create: {
        id: providerId,
        organizationId,
        slug: `rp-${organizationId}`.slice(0, 40).toLowerCase(),
        name: 'rp',
        type: 'OPENAI_COMPATIBLE',
        baseUrl: 'http://mock.test/v1',
      },
      update: {},
    });
    await db().model.create({
      data: {
        id: `mdl_rp_${organizationId}_${slug}`,
        organizationId,
        providerId,
        slug,
        upstreamModel: 'mock-small',
        inputPrice: price,
        outputPrice: price,
      },
    });
  };
  const snapshot = async () => {
    const version = await app.get(SnapshotService).rebuild('test');
    const row = await db().configVersion.findUnique({ where: { version } });
    return row?.snapshot as Record<string, unknown>;
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
    await db().$executeRawUnsafe(
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, teams, providers, models, routing_rules, request_log, change_requests, organizations CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const setup = async (organizationName: string, email: string) => {
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: { organizationName, name: 'O', email, password: 'a-long-enough-password' },
        });
    };
    await setup('Routing', 'owner@rp.example.com');
    tokens.owner = await login('owner@rp.example.com');
    org =
      (await inject(tokens.owner, 'GET', 'auth/me')).json<{ organizations: { id: string }[] }>()
        .organizations[0]?.id ?? '';
    otherOrg = 'org_rp_other';
    await db().organization.create({ data: { id: otherOrg, name: 'Other', slug: 'rp-other' } });
    team = (await call('POST', 'teams', { name: 'Search' })).json<{ id: string }>().id;
    await addModel(org, 'cheap', '0.1');
    await addModel(org, 'big', '30');
    await addModel(otherOrg, 'theirs', '1');
    await member('viewer', 'VIEWER');
    await member('member', 'MEMBER');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('rules (card 32.2)', () => {
    let ruleId = '';

    it('saves a rule on the team budget and publishes it in the snapshot', async () => {
      const res = await call('POST', 'routing/rules', {
        name: 'team over budget',
        teamId: team,
        condition: 'budget.team > 80',
        action: { type: 'route', target: 'cheap' },
      });
      expect(res.statusCode).toBe(201);
      ruleId = res.json<{ id: string }>().id;
      const image = await snapshot();
      expect(image.routingRules).toEqual([
        expect.objectContaining({
          id: ruleId,
          organizationId: org,
          teamId: team,
          condition: 'budget.team > 80',
          action: { type: 'route', target: 'cheap' },
        }),
      ]);
    });

    it.each([
      ['budget.team >', 'expected a value'],
      ['request.nope == 1', 'unknown field'],
      ['request.model == 3', 'cannot compare'],
      ['request.model', 'must be true or false'],
    ])('rejects the invalid condition %s at save time', async (condition, problem) => {
      const res = await call('POST', 'routing/rules', {
        name: 'bad',
        condition,
        action: { type: 'route', target: 'cheap' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain(problem);
      const patched = await call('PATCH', `routing/rules/${ruleId}`, { condition });
      expect(patched.statusCode).toBe(400);
    });

    it('validates a condition without saving it', async () => {
      const ok = await call('POST', 'routing/rules/validate', { condition: "key.team == 'x'" });
      expect(ok.json()).toMatchObject({ valid: true });
      const bad = await call('POST', 'routing/rules/validate', { condition: 'nope' });
      expect(bad.json<{ valid: boolean; problem: string }>().problem).toContain('unknown variable');
    });

    it('refuses targets and teams outside the organization', async () => {
      const foreign = await call('POST', 'routing/rules', {
        name: 'x',
        condition: 'true',
        action: { type: 'route', target: 'theirs' },
      });
      expect(foreign.statusCode).toBe(400);
      const auto = await call('POST', 'routing/rules', {
        name: 'to auto',
        condition: "request.metadata.kind == 'agent'",
        action: { type: 'route', target: 'auto/cheap' },
      });
      expect(auto.statusCode).toBe(201);
      await call('DELETE', `routing/rules/${auto.json<{ id: string }>().id}`);
      const badTeam = await call('POST', 'routing/rules', {
        name: 'x',
        teamId: 'team_nope',
        condition: 'true',
        action: { type: 'tag', tags: { a: 'b' } },
      });
      expect(badTeam.statusCode).toBe(400);
      expect(
        (
          await call('POST', 'routing/rules', {
            name: 'x',
            condition: 'true',
            action: { type: 'tag', tags: {} },
          })
        ).statusCode,
      ).toBe(422);
    });

    it('needs models:write to change rules; viewers and members only read', async () => {
      const body = { name: 'm', condition: 'true', action: { type: 'tag', tags: { a: 'b' } } };
      expect(
        (await inject(tokens.member ?? '', 'POST', `orgs/${org}/routing/rules`, body)).statusCode,
      ).toBe(403);
      expect(
        (await inject(tokens.viewer ?? '', 'GET', `orgs/${org}/routing/rules`)).statusCode,
      ).toBe(200);
    });

    it("never shows or changes another organization's rules", async () => {
      await db().routingRule.create({
        data: {
          id: 'rrl_other',
          organizationId: otherOrg,
          name: 'theirs',
          priority: 1,
          condition: 'true',
          action: { type: 'tag', tags: { a: 'b' } },
        },
      });
      const list = (await call('GET', 'routing/rules')).json<{ id: string }[]>();
      expect(list.map((r) => r.id)).toEqual([ruleId]);
      expect((await call('PATCH', 'routing/rules/rrl_other', { name: 'mine' })).statusCode).toBe(
        404,
      );
      expect((await call('DELETE', 'routing/rules/rrl_other')).statusCode).toBe(404);
    });

    it("reports each rule's share of the organization's traffic", async () => {
      const now = new Date();
      const row = (n: number, organizationId: string, policy?: object) => ({
        id: `req_rp_${organizationId}_${String(n)}`,
        createdAt: now,
        organizationId,
        projectId: 'prj',
        apiKeyId: 'vk',
        inboundApi: 'openai.chat',
        requestedModel: 'big',
        stream: false,
        status: 'success',
        httpStatus: 200,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: '0',
        latencyMs: 10,
        configVersion: 1,
        gatewayInstance: 'gw',
        ...(policy ? { policy } : {}),
      });
      await db().requestLog.createMany({
        data: [
          row(1, org, { rules: { matched: [ruleId], decidedBy: ruleId, target: 'cheap' } }),
          row(2, org, { rules: { matched: [ruleId], decidedBy: ruleId, target: 'cheap' } }),
          row(3, org),
          row(4, org),
          row(5, otherOrg, { rules: { matched: [ruleId], decidedBy: ruleId } }),
        ],
      });
      const res = await call('GET', 'routing/rules/traffic');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        totalRequests: 4,
        rules: [{ id: ruleId, matched: 2, decided: 2, share: 0.5 }],
      });
    });

    it('deletes a rule and drops it from the snapshot', async () => {
      expect((await call('DELETE', `routing/rules/${ruleId}`)).statusCode).toBe(204);
      const image = await snapshot();
      expect(
        ((image.routingRules ?? []) as { organizationId: string }[]).filter(
          (r) => r.organizationId === org,
        ),
      ).toEqual([]);
    });
  });
});
