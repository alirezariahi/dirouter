/**
 * Management API tokens and service accounts over HTTP (card 23.6): a token creates a virtual key
 * and reads stats without any user signing in, a read-only token cannot change anything, a revoked
 * token is refused on its next request, and every use is in the audit log.
 * Runs only with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL.
 */
import { createHash } from 'node:crypto';

import { generateKey, prefixedId } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { hashPassword } from '../auth/crypto.js';
import { PERMISSIONS } from '../rbac/permissions.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';
const READ_SCOPES = PERMISSIONS.filter((p) => p.endsWith(':read'));

interface Account {
  id: string;
  userId: string;
  role: string;
  tokens: { id: string; revokedAt: string | null }[];
}
interface Issued {
  id: string;
  token: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
}

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('service accounts and management tokens', () => {
  let app: NestFastifyApplication;
  let owner = '';
  let org = '';
  let otherOrg = '';
  let project = '';

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    bearer: string,
    body?: unknown,
    ip = '10.0.0.1',
  ) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        remoteAddress: ip,
        headers: {
          'x-forwarded-proto': 'https',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const db = () => app.get(PrismaService).client;

  async function account(role: 'ADMIN' | 'MEMBER' | 'VIEWER', name = `sa-${role}`) {
    const res = await call('POST', `orgs/${org}/service-accounts`, owner, { name, role });
    expect(res.statusCode).toBe(201);
    return res.json<Account>();
  }
  async function issue(
    accountId: string,
    scopes: readonly string[],
    extra: Record<string, unknown> = {},
  ) {
    const res = await call('POST', `orgs/${org}/service-accounts/${accountId}/tokens`, owner, {
      name: 'ci',
      scopes,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<Issued>();
  }
  async function login(email: string) {
    return (await call('POST', 'auth/login', '', { email, password: PW })).json<{
      accessToken: string;
    }>().accessToken;
  }

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
    });
    app = await createApp(env);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await db().$executeRawUnsafe(
      'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, budgets, api_keys, projects, teams, management_tokens, service_accounts, users, organizations CASCADE',
    );
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    owner = (
      await call('POST', 'auth/setup', '', {
        organizationName: 'Automation Org',
        name: 'Owner',
        email: 'owner@sa.test',
        password: PW,
      })
    ).json<{ accessToken: string }>().accessToken;
    org = (await db().organization.findFirstOrThrow()).id;
    project = (await call('POST', `orgs/${org}/projects`, owner, { name: 'Prod' })).json<{
      id: string;
    }>().id;
    const other = await db().organization.create({
      data: { id: prefixedId('org'), name: 'Other', slug: 'other-sa' },
    });
    otherOrg = other.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('a token creates a virtual key and reads stats without any user signing in', async () => {
    const sa = await account('ADMIN', 'terraform');
    // A service account is a member with a role, but not a person: no sign-in, not in the member list.
    const members = (await call('GET', `orgs/${org}/members`, owner)).json<{ userId: string }[]>();
    expect(members.map((m) => m.userId)).not.toContain(sa.userId);
    const backing = await db().user.findUniqueOrThrow({ where: { id: sa.userId } });
    expect(backing).toMatchObject({ isServiceAccount: true, passwordHash: '' });
    const signIn = await call('POST', 'auth/login', '', { email: backing.email, password: '' });
    expect(signIn.statusCode).toBe(422);
    expect(
      (await call('POST', 'auth/login', '', { email: backing.email, password: 'x' })).statusCode,
    ).toBe(401);

    const issued = await issue(sa.id, ['keys:read', 'keys:write', 'usage:read', 'projects:read']);
    expect(issued.token).toMatch(/^drm_[A-Za-z0-9_-]{43}$/);
    expect(issued.prefix).toBe(issued.token.slice(0, 12));
    expect(issued.expiresAt).not.toBeNull();
    const stored = await db().managementToken.findUniqueOrThrow({ where: { id: issued.id } });
    expect(stored.tokenHash).toBe(createHash('sha256').update(issued.token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    // The listing never shows the token again.
    const listed = (await call('GET', `orgs/${org}/service-accounts`, owner)).body;
    expect(listed).not.toContain(issued.token);
    expect(listed).toContain(issued.prefix);

    const created = await call('POST', `orgs/${org}/keys`, issued.token, {
      name: 'from-ci',
      projectId: project,
    });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ id: string; key: string }>();
    expect(key.key).toMatch(/^dr-/);
    expect((await db().apiKey.findUniqueOrThrow({ where: { id: key.id } })).createdById).toBe(
      sa.userId,
    );
    expect((await call('GET', `orgs/${org}/keys`, issued.token)).statusCode).toBe(200);
    const stats = await call('GET', `orgs/${org}/stats/overview`, issued.token);
    expect(stats.statusCode).toBe(200);

    // Use is audited: the change with the service account as actor, and the token's use itself.
    const used = await db().auditLog.findMany({
      where: { action: 'management_token.used', targetId: issued.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(used.length).toBeGreaterThanOrEqual(1);
    expect(used.some((row) => (row.diff as { method?: string }).method === 'POST')).toBe(true);
    expect(used[0]).toMatchObject({ actorUserId: sa.userId, ip: '10.0.0.1', organizationId: org });
    expect(
      await db().auditLog.count({
        where: {
          actorUserId: sa.userId,
          targetId: key.id,
          NOT: { action: 'management_token.used' },
        },
      }),
    ).toBeGreaterThanOrEqual(1);
    const row = await db().managementToken.findUniqueOrThrow({ where: { id: issued.id } });
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.lastUsedIp).toBe('10.0.0.1');
  });

  it('reads are audited at most once an hour per token and address, every change always', async () => {
    const sa = await account('VIEWER', 'reader');
    const issued = await issue(sa.id, ['keys:read']);
    for (let i = 0; i < 3; i++)
      expect((await call('GET', `orgs/${org}/keys`, issued.token)).statusCode).toBe(200);
    const count = () =>
      db().auditLog.count({ where: { action: 'management_token.used', targetId: issued.id } });
    expect(await count()).toBe(1);
    expect(
      (await call('GET', `orgs/${org}/keys`, issued.token, undefined, '10.9.9.9')).statusCode,
    ).toBe(200);
    expect(await count()).toBe(2);
  });

  it('a read-only token cannot change anything', async () => {
    const sa = await account('ADMIN', 'auditor');
    const readOnly = await issue(sa.id, READ_SCOPES);
    expect((await call('GET', `orgs/${org}/keys`, readOnly.token)).statusCode).toBe(200);
    expect((await call('GET', `orgs/${org}/members`, readOnly.token)).statusCode).toBe(200);
    const attempts = [
      await call('POST', `orgs/${org}/keys`, readOnly.token, { name: 'nope', projectId: project }),
      await call('PATCH', `orgs/${org}`, readOnly.token, { name: 'Renamed' }),
      await call('POST', `orgs/${org}/projects`, readOnly.token, { name: 'Nope' }),
      await call('DELETE', `orgs/${org}/projects/${project}`, readOnly.token),
      await call('POST', `orgs/${org}/invitations`, readOnly.token, {
        email: 'x@sa.test',
        role: 'VIEWER',
      }),
      // Change requests need a second person: org:read alone would otherwise let a token approve.
      await call('POST', `orgs/${org}/change-requests/chr_x/approve`, readOnly.token, {}),
      // Managing service accounts and tokens is for people only, whatever the scopes.
      await call('POST', `orgs/${org}/service-accounts`, readOnly.token, {
        name: 'x',
        role: 'VIEWER',
      }),
    ];
    for (const res of attempts) expect(res.statusCode, res.body).toBe(403);
    expect((await db().organization.findUniqueOrThrow({ where: { id: org } })).name).toBe(
      'Automation Org',
    );
    expect(await db().apiKey.count({ where: { name: 'nope' } })).toBe(0);
  });

  it('scopes are capped by the service account role, now and later', async () => {
    const sa = await account('VIEWER', 'viewer-sa');
    const beyond = await call('POST', `orgs/${org}/service-accounts/${sa.id}/tokens`, owner, {
      name: 'too much',
      scopes: ['keys:write'],
    });
    expect(beyond.statusCode).toBe(422);
    // An admin token loses write access as soon as its account is demoted.
    const admin = await account('ADMIN', 'demoted');
    const writer = await issue(admin.id, ['projects:write']);
    expect(
      (await call('POST', `orgs/${org}/projects`, writer.token, { name: 'Made by token' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await call('PATCH', `orgs/${org}/service-accounts/${admin.id}`, owner, { role: 'VIEWER' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call('POST', `orgs/${org}/projects`, writer.token, { name: 'Again' })).statusCode,
    ).toBe(403);
  });

  it('a revoked, expired or deleted token is refused on its next request', async () => {
    const sa = await account('ADMIN', 'revocable');
    const issued = await issue(sa.id, ['keys:read']);
    expect((await call('GET', `orgs/${org}/keys`, issued.token)).statusCode).toBe(200);
    expect(
      (await call('DELETE', `orgs/${org}/management-tokens/${issued.id}`, owner)).statusCode,
    ).toBe(204);
    const refused = await call('GET', `orgs/${org}/keys`, issued.token);
    expect(refused.statusCode).toBe(401);
    expect(
      await db().auditLog.count({
        where: { action: 'management_token.revoked', targetId: issued.id },
      }),
    ).toBe(1);

    const expiring = await issue(sa.id, ['keys:read'], { expiresInDays: 1 });
    await db().managementToken.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call('GET', `orgs/${org}/keys`, expiring.token)).statusCode).toBe(401);

    const forever = await issue(sa.id, ['keys:read'], { expiresInDays: null });
    expect(forever.expiresAt).toBeNull();
    expect((await call('GET', `orgs/${org}/keys`, forever.token)).statusCode).toBe(200);
    expect((await call('DELETE', `orgs/${org}/service-accounts/${sa.id}`, owner)).statusCode).toBe(
      204,
    );
    expect((await call('GET', `orgs/${org}/keys`, forever.token)).statusCode).toBe(401);
    expect(
      (await db().managementToken.findUniqueOrThrow({ where: { id: forever.id } })).revokedAt,
    ).not.toBeNull();
    expect((await call('GET', 'auth/me', 'drm_not-a-real-token')).statusCode).toBe(401);
  });

  it('honours the IP allow-list and works only on its own organization', async () => {
    const sa = await account('ADMIN', 'pinned');
    const pinned = await issue(sa.id, ['keys:read'], {
      allowedIps: ['192.168.0.0/16', '2001:db8::1'],
    });
    const outside = await call('GET', `orgs/${org}/keys`, pinned.token, undefined, '10.0.0.1');
    expect(outside.statusCode).toBe(403);
    expect(
      (await call('GET', `orgs/${org}/keys`, pinned.token, undefined, '192.168.4.2')).statusCode,
    ).toBe(200);
    expect(
      (await call('GET', `orgs/${org}/keys`, pinned.token, undefined, '2001:db8::1')).statusCode,
    ).toBe(200);
    const bad = await call('POST', `orgs/${org}/service-accounts/${sa.id}/tokens`, owner, {
      name: 'bad',
      scopes: ['keys:read'],
      allowedIps: ['10.0.0.0/33'],
    });
    expect(bad.statusCode).toBe(422);

    const anywhere = await issue(sa.id, ['keys:read', 'org:read']);
    expect((await call('GET', `orgs/${otherOrg}/keys`, anywhere.token)).statusCode).toBe(404);
    // User routes (account, sessions, MFA) are not for tokens.
    expect((await call('GET', 'auth/me', anywhere.token)).statusCode).toBe(403);
    expect((await call('GET', 'auth/sessions', anywhere.token)).statusCode).toBe(403);
  });

  it('only people who can manage security create service accounts, within their own power', async () => {
    const db_ = db();
    const memberUser = await db_.user.create({
      data: {
        id: prefixedId('usr'),
        email: 'member@sa.test',
        name: 'Member',
        passwordHash: await hashPassword(PW),
      },
    });
    await db_.membership.create({
      data: { id: prefixedId('mem'), userId: memberUser.id, organizationId: org, role: 'MEMBER' },
    });
    const member = await login('member@sa.test');
    expect(
      (
        await call('POST', `orgs/${org}/service-accounts`, member, {
          name: 'mine',
          role: 'VIEWER',
        })
      ).statusCode,
    ).toBe(403);
    // Members can see service accounts (members:read), not create tokens.
    const list = await call('GET', `orgs/${org}/service-accounts`, member);
    expect(list.statusCode).toBe(200);
    const sa = list.json<Account[]>()[0];
    expect(
      (
        await call('POST', `orgs/${org}/service-accounts/${sa?.id}/tokens`, member, {
          name: 'x',
          scopes: ['keys:read'],
        })
      ).statusCode,
    ).toBe(403);
    // OWNER is never a service account role.
    expect(
      (await call('POST', `orgs/${org}/service-accounts`, owner, { name: 'x', role: 'OWNER' }))
        .statusCode,
    ).toBe(422);
    // A service account is not reachable through the member routes.
    expect(
      (await call('PATCH', `orgs/${org}/members/${sa?.userId}`, owner, { role: 'ADMIN' }))
        .statusCode,
    ).toBe(404);
    expect(
      await db_.auditLog.count({
        where: { action: 'service_account.created', organizationId: org },
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});
