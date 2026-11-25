/** Change requests: four-eyes approval for sensitive changes (card 22.2). */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { hashPassword } from '../auth/crypto.js';
import { PrismaService } from '../infra/prisma.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const MASTER_KEY = generateKey();

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('change requests over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
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
  /** A second and third member, signed in with a password. */
  const member = async (name: string, role: 'ADMIN' | 'VIEWER') => {
    const db = app.get(PrismaService).client;
    const id = `usr_cr_${name}`;
    await db.user.create({
      data: {
        id,
        email: `${name}@cr.example.com`,
        name,
        passwordHash: await hashPassword('a-long-enough-password'),
      },
    });
    await db.membership.create({
      data: { id: `mem_cr_${name}`, userId: id, organizationId: org, role },
    });
    const login = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `${name}@cr.example.com`, password: 'a-long-enough-password' },
      });
    tokens[name] = login.json<{ accessToken: string }>().accessToken;
    ids[name] = id;
  };

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
        MASTER_KEY,
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
        PUBLIC_GATEWAY_URL: 'https://api.example.com',
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, change_requests, providers, credentials, organizations CASCADE',
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    token = (
      await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'FourEyes',
            name: 'O',
            email: 'owner@cr.example.com',
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
            headers: { authorization: `Bearer ${token}` },
          })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
  });

  afterAll(async () => {
    await app.close();
  });

  it('without four-eyes nothing changes: a delete runs at once', async () => {
    await member('admin', 'ADMIN');
    await member('viewer', 'VIEWER');
    tokens.owner = token;
    const p = await call('POST', 'providers', { name: 'Quick', type: 'openai', credentials: [] });
    expect((await call('DELETE', `providers/${p.json<{ id: string }>().id}`)).statusCode).toBe(204);
  });

  it('a sensitive change waits; the requester cannot approve it, a second person applies it', async () => {
    expect(
      (await call('PATCH', 'security', { changeApprovalRequired: true })).json(),
    ).toMatchObject({ changeApprovalRequired: true });
    const provider = (await call('POST', 'providers', { name: 'OpenAI', type: 'openai' })).json<{
      id: string;
    }>().id;

    const asked = await call('DELETE', `providers/${provider}`);
    expect(asked.statusCode).toBe(202);
    const request = asked.json<{ changeRequest: { id: string; status: string; summary: string } }>()
      .changeRequest;
    expect(request).toMatchObject({ status: 'pending', summary: 'Delete provider OpenAI' });
    expect((await call('GET', `providers/${provider}`)).statusCode).toBe(200);

    const self = await call('POST', `change-requests/${request.id}/approve`);
    expect(self.statusCode).toBe(403);
    expect(self.body).toContain('someone other than its requester');
    // A second person without the operation's permission cannot approve either.
    expect((await as('viewer', 'POST', `change-requests/${request.id}/approve`)).statusCode).toBe(
      403,
    );

    const approved = await as('admin', 'POST', `change-requests/${request.id}/approve`);
    expect(approved.json()).toMatchObject({ status: 'applied', decidedById: ids.admin });
    expect((await call('GET', `providers/${provider}`)).statusCode).toBe(404);
    expect((await as('admin', 'POST', `change-requests/${request.id}/approve`)).statusCode).toBe(
      409,
    );

    const audit = await app.get(PrismaService).client.auditLog.findMany({
      where: { targetId: request.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'change_request.created',
      'change_request.applied',
    ]);
  });

  it('role changes run as the approver, with every rule of the operation', async () => {
    const toAdmin = await call('PATCH', `members/${ids.viewer}`, { role: 'MEMBER' });
    expect(toAdmin.statusCode).toBe(202);
    const id = toAdmin.json<{ changeRequest: { id: string } }>().changeRequest.id;
    expect((await as('admin', 'POST', `change-requests/${id}/approve`)).json()).toMatchObject({
      status: 'applied',
    });
    const members = (await call('GET', 'members')).json<{ userId: string; role: string }[]>();
    expect(members.find((m) => m.userId === ids.viewer)?.role).toBe('MEMBER');

    // The approver may not change their own access: applying fails and the request records why.
    const own = await call('PATCH', `members/${ids.admin}`, { role: 'VIEWER' });
    const ownId = own.json<{ changeRequest: { id: string } }>().changeRequest.id;
    const failed = await as('admin', 'POST', `change-requests/${ownId}/approve`);
    expect(failed.json()).toMatchObject({ status: 'failed' });
    expect(failed.json<{ error: string }>().error).toBeTruthy();
  });

  it('key budgets wait for approval, other key edits do not; rejection and cancellation', async () => {
    const project = (await call('POST', 'projects', { name: 'P' })).json<{ id: string }>().id;
    const key = (await call('POST', 'keys', { name: 'k', projectId: project })).json<{
      id: string;
    }>().id;
    expect((await call('PATCH', `keys/${key}`, { name: 'renamed' })).statusCode).toBe(200);
    const budget = await call('PATCH', `keys/${key}`, {
      budgets: [{ period: 'monthly', limitUsd: '100' }],
    });
    expect(budget.statusCode).toBe(202);
    const id = budget.json<{ changeRequest: { id: string } }>().changeRequest.id;
    expect(
      (await as('admin', 'POST', `change-requests/${id}/reject`, { reason: 'too high' })).json(),
    ).toMatchObject({ status: 'rejected', reason: 'too high' });
    expect((await call('GET', `keys/${key}`)).json<{ budgets: unknown[] }>().budgets).toEqual([]);

    // Turning four-eyes off is itself a change request; its requester may cancel it.
    const off = await call('PATCH', 'security', { changeApprovalRequired: false });
    expect(off.statusCode).toBe(202);
    const offId = off.json<{ changeRequest: { id: string } }>().changeRequest.id;
    expect((await call('POST', `change-requests/${offId}/reject`)).json()).toMatchObject({
      status: 'cancelled',
    });
    const list = (await call('GET', 'change-requests?status=pending')).json<unknown[]>();
    expect(list).toEqual([]);
    const again = (await call('PATCH', 'security', { changeApprovalRequired: false })).json<{
      changeRequest: { id: string };
    }>();
    await as('admin', 'POST', `change-requests/${again.changeRequest.id}/approve`);
    expect((await call('GET', 'security')).json()).toMatchObject({ changeApprovalRequired: false });
  });

  it('a management token does not let the person behind it approve their own request', async () => {
    const db = app.get(PrismaService).client;
    const ownerId = (await db.user.findFirstOrThrow({ where: { email: 'owner@cr.example.com' } }))
      .id;
    expect(
      (await call('PATCH', 'security', { changeApprovalRequired: true })).json(),
    ).toMatchObject({ changeApprovalRequired: true });
    /** `who` creates a service account; `issuer` gives it a token; returns the token. */
    const automation = async (who: string, issuer: string, name: string) => {
      const sa = await as(who, 'POST', 'service-accounts', { name, role: 'ADMIN' });
      expect(sa.statusCode, sa.body).toBe(201);
      const issued = await as(
        issuer,
        'POST',
        `service-accounts/${sa.json<{ id: string }>().id}/tokens`,
        { name: 'ci', scopes: ['providers:read', 'providers:write'] },
      );
      expect(issued.statusCode, issued.body).toBe(201);
      return {
        token: issued.json<{ token: string }>().token,
        userId: sa.json<{ userId: string }>().userId,
      };
    };
    const requestDelete = async (token: string, name: string) => {
      const provider = (await call('POST', 'providers', { name, type: 'openai' })).json<{
        id: string;
      }>().id;
      tokens.bot = token;
      const asked = await as('bot', 'DELETE', `providers/${provider}`);
      expect(asked.statusCode, asked.body).toBe(202);
      return asked.json<{ changeRequest: { id: string; requestedById: string } }>().changeRequest;
    };

    // The owner's own token: the request is the service account's, but the owner stands behind it.
    const mine = await automation('owner', 'owner', 'owner-bot');
    const request = await requestDelete(mine.token, 'Via token');
    expect(request.requestedById).toBe(mine.userId);
    const listed = (await call('GET', 'change-requests?status=pending')).json<
      { id: string; requestedByHumanId: string | null }[]
    >();
    expect(listed.find((r) => r.id === request.id)?.requestedByHumanId).toBe(ownerId);
    const self = await call('POST', `change-requests/${request.id}/approve`);
    expect(self.statusCode).toBe(403);
    expect(self.body).toContain('someone other than its requester');
    expect(
      (await as('admin', 'POST', `change-requests/${request.id}/approve`)).json(),
    ).toMatchObject({ status: 'applied' });

    // The person who created the service account cannot approve what its tokens ask for either,
    // even when someone else issued the token.
    const theirs = await automation('admin', 'owner', 'admin-bot');
    const second = await requestDelete(theirs.token, 'Via admin bot');
    expect((await as('admin', 'POST', `change-requests/${second.id}/approve`)).statusCode).toBe(
      403,
    );
    expect((await call('POST', `change-requests/${second.id}/approve`)).statusCode).toBe(403);
    expect((await call('GET', `change-requests?status=pending`)).json<{ id: string }[]>()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: second.id })]),
    );
  });
});
