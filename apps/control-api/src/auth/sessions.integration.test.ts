/**
 * Sign-in sessions over HTTP (card 23.5): listing, revoking one, "sign out everywhere", and an
 * administrator signing a member out. Runs only with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL.
 */
import { generateKey, prefixedId } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { REFRESH_COOKIE } from './auth.controller.js';
import { hashPassword } from './crypto.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

interface SessionRow {
  id: string;
  device: string;
  ip: string | null;
  current: boolean;
  method: string;
  createdAt: string;
  lastActiveAt: string;
}

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('sign-in sessions over HTTP', () => {
  let app: NestFastifyApplication;
  let orgId = '';
  const password = 'a-long-enough-password';

  const inject = (opts: {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    body?: unknown;
    cookie?: string;
    token?: string;
    ip?: string;
    ua?: string;
  }) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: opts.method,
        url: `/api/v1/${opts.url}`,
        remoteAddress: opts.ip ?? '10.0.0.1',
        headers: {
          'x-forwarded-proto': 'https',
          ...(opts.ua ? { 'user-agent': opts.ua } : {}),
          ...(opts.cookie ? { cookie: `${REFRESH_COOKIE}=${opts.cookie}` } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
      });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
    res.cookies.find((c) => c.name === REFRESH_COOKIE)?.value ?? '';

  async function signIn(email: string, ip: string, ua: string) {
    const res = await inject({
      method: 'POST',
      url: 'auth/login',
      body: { email, password },
      ip,
      ua,
    });
    expect(res.statusCode).toBe(200);
    return { token: res.json<{ accessToken: string }>().accessToken, cookie: cookieOf(res) };
  }

  async function addMember(email: string, role: 'ADMIN' | 'MEMBER' | 'VIEWER') {
    const db = app.get(PrismaService).client;
    const user = await db.user.create({
      data: {
        id: prefixedId('usr'),
        email,
        name: email,
        passwordHash: await hashPassword(password),
      },
    });
    await db.membership.create({
      data: { id: prefixedId('mem'), userId: user.id, organizationId: orgId, role },
    });
    return user.id;
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
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, organizations CASCADE',
    );
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    const setup = await inject({
      method: 'POST',
      url: 'auth/setup',
      body: { organizationName: 'Sessions Org', name: 'Owner', email: 'owner@s.test', password },
    });
    expect(setup.statusCode).toBe(201);
    orgId = (await db.organization.findFirstOrThrow()).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists active sessions with device, address and last activity, marking the current one', async () => {
    const laptop = await signIn('owner@s.test', '10.1.1.1', FIREFOX_LINUX);
    const phone = await signIn('owner@s.test', '10.2.2.2', SAFARI_IPHONE);
    const list = await inject({ method: 'GET', url: 'auth/sessions', token: laptop.token });
    expect(list.statusCode).toBe(200);
    const sessions = list.json<SessionRow[]>();
    const mine = sessions.find((s) => s.current);
    expect(mine).toMatchObject({ device: 'Firefox on Linux', ip: '10.1.1.1', method: 'pwd' });
    expect(sessions.find((s) => s.ip === '10.2.2.2')).toMatchObject({
      device: 'Safari on iOS',
      current: false,
    });
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    // A refresh keeps the same session and moves its last activity and address forward.
    const before = sessions.find((s) => s.ip === '10.2.2.2');
    const rotated = await inject({
      method: 'POST',
      url: 'auth/refresh',
      cookie: phone.cookie,
      ip: '10.2.2.3',
      ua: SAFARI_IPHONE,
    });
    expect(rotated.statusCode).toBe(200);
    const after = (await inject({ method: 'GET', url: 'auth/sessions', token: laptop.token }))
      .json<SessionRow[]>()
      .find((s) => s.id === before?.id);
    expect(after).toMatchObject({ ip: '10.2.2.3', createdAt: before?.createdAt });
    expect(Date.parse(after?.lastActiveAt ?? '')).toBeGreaterThanOrEqual(
      Date.parse(before?.lastActiveAt ?? ''),
    );
  });

  it('revoking a session ends its refresh token and its access token immediately', async () => {
    const laptop = await signIn('owner@s.test', '10.3.3.3', FIREFOX_LINUX);
    const phone = await signIn('owner@s.test', '10.4.4.4', SAFARI_IPHONE);
    const target = (await inject({ method: 'GET', url: 'auth/sessions', token: phone.token }))
      .json<SessionRow[]>()
      .find((s) => s.current);
    expect(target).toBeDefined();
    expect((await inject({ method: 'GET', url: 'auth/me', token: phone.token })).statusCode).toBe(
      200,
    );

    const revoked = await inject({
      method: 'DELETE',
      url: `auth/sessions/${target?.id}`,
      token: laptop.token,
    });
    expect(revoked.statusCode).toBe(204);
    const refresh = await inject({ method: 'POST', url: 'auth/refresh', cookie: phone.cookie });
    expect(refresh.statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: 'auth/me', token: phone.token })).statusCode).toBe(
      401,
    );
    // The session doing the revoking is untouched.
    expect((await inject({ method: 'GET', url: 'auth/me', token: laptop.token })).statusCode).toBe(
      200,
    );
    const listed = (await inject({ method: 'GET', url: 'auth/sessions', token: laptop.token }))
      .json<SessionRow[]>()
      .map((s) => s.id);
    expect(listed).not.toContain(target?.id);
    // Revoking it again, or a session that does not exist, is 404.
    expect(
      (await inject({ method: 'DELETE', url: `auth/sessions/${target?.id}`, token: laptop.token }))
        .statusCode,
    ).toBe(404);

    const audit = await app.get(PrismaService).client.auditLog.findFirst({
      where: { action: 'session.revoked', targetId: target?.id ?? '' },
    });
    expect(audit).toMatchObject({ organizationId: orgId, targetType: 'session', ip: '10.0.0.1' });
  });

  it("cannot see or revoke another user's sessions", async () => {
    await addMember('other@s.test', 'MEMBER');
    const other = await signIn('other@s.test', '10.5.5.5', FIREFOX_LINUX);
    const owner = await signIn('owner@s.test', '10.6.6.6', FIREFOX_LINUX);
    const ownerSessions = (
      await inject({ method: 'GET', url: 'auth/sessions', token: owner.token })
    ).json<SessionRow[]>();
    const otherSessions = (
      await inject({ method: 'GET', url: 'auth/sessions', token: other.token })
    ).json<SessionRow[]>();
    expect(otherSessions).toHaveLength(1);
    expect(otherSessions.map((s) => s.id)).not.toContain(ownerSessions[0]?.id);
    const attempt = await inject({
      method: 'DELETE',
      url: `auth/sessions/${ownerSessions[0]?.id}`,
      token: other.token,
    });
    expect(attempt.statusCode).toBe(404);
    expect((await inject({ method: 'GET', url: 'auth/me', token: owner.token })).statusCode).toBe(
      200,
    );
  });

  it('signs out everywhere else, or everywhere including the current session', async () => {
    const a = await signIn('owner@s.test', '10.7.7.1', FIREFOX_LINUX);
    const b = await signIn('owner@s.test', '10.7.7.2', SAFARI_IPHONE);
    const others = await inject({
      method: 'POST',
      url: 'auth/sessions/revoke-all',
      token: a.token,
      body: {},
    });
    expect(others.statusCode).toBe(200);
    expect(others.json<{ revoked: number }>().revoked).toBeGreaterThanOrEqual(1);
    expect((await inject({ method: 'GET', url: 'auth/me', token: b.token })).statusCode).toBe(401);
    expect(
      (await inject({ method: 'POST', url: 'auth/refresh', cookie: b.cookie })).statusCode,
    ).toBe(401);
    const left = (await inject({ method: 'GET', url: 'auth/sessions', token: a.token })).json<
      SessionRow[]
    >();
    expect(left).toHaveLength(1);
    expect(left[0]?.current).toBe(true);

    const all = await inject({
      method: 'POST',
      url: 'auth/sessions/revoke-all',
      token: a.token,
      body: { includeCurrent: true },
    });
    expect(all.json()).toEqual({ revoked: 1 });
    expect(all.cookies.find((c) => c.name === REFRESH_COOKIE)?.value).toBe('');
    expect((await inject({ method: 'GET', url: 'auth/me', token: a.token })).statusCode).toBe(401);
    expect(
      (await inject({ method: 'POST', url: 'auth/refresh', cookie: a.cookie })).statusCode,
    ).toBe(401);
    expect(
      await app
        .get(PrismaService)
        .client.auditLog.count({ where: { action: 'session.revoked_all' } }),
    ).toBe(2);
  });

  it('an administrator can list and revoke the sessions of a member, but not of someone above them', async () => {
    const adminId = await addMember('admin@s.test', 'ADMIN');
    const viewerId = await addMember('viewer@s.test', 'VIEWER');
    const admin = await signIn('admin@s.test', '10.8.8.1', FIREFOX_LINUX);
    const viewer = await signIn('viewer@s.test', '10.8.8.2', SAFARI_IPHONE);
    const owner = await signIn('owner@s.test', '10.8.8.3', FIREFOX_LINUX);

    const seen = await inject({
      method: 'GET',
      url: `orgs/${orgId}/members/${viewerId}/sessions`,
      token: admin.token,
    });
    expect(seen.statusCode).toBe(200);
    // A session is the member's, across all their organizations: the administrator of one sees
    // that it exists and when it was active, not where from or on which device.
    const rows = seen.json<(SessionRow & { userAgent: string | null })[]>();
    expect(rows).toMatchObject([
      { ip: null, userAgent: null, device: 'Hidden', method: 'pwd', current: false },
    ]);
    expect(Date.parse(rows[0]?.lastActiveAt ?? '')).toBeGreaterThan(0);
    expect(seen.body).not.toContain('10.8.8.2');
    expect(seen.body).not.toContain('iPhone');

    // Neither route is open to a management token, whatever its scopes.
    const sa = await inject({
      method: 'POST',
      url: `orgs/${orgId}/service-accounts`,
      token: owner.token,
      body: { name: 'hr-sync', role: 'ADMIN' },
    });
    expect(sa.statusCode, sa.body).toBe(201);
    const issued = await inject({
      method: 'POST',
      url: `orgs/${orgId}/service-accounts/${sa.json<{ id: string }>().id}/tokens`,
      token: owner.token,
      body: { name: 'ci', scopes: ['members:read', 'members:write'] },
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const bot = issued.json<{ token: string }>().token;
    for (const [method, url] of [
      ['GET', `orgs/${orgId}/members/${viewerId}/sessions`],
      ['POST', `orgs/${orgId}/members/${viewerId}/sessions/revoke`],
    ] as const)
      expect((await inject({ method, url, token: bot })).statusCode).toBe(403);

    // A viewer cannot sign anybody out.
    const denied = await inject({
      method: 'POST',
      url: `orgs/${orgId}/members/${adminId}/sessions/revoke`,
      token: viewer.token,
    });
    expect(denied.statusCode).toBe(403);

    const revoked = await inject({
      method: 'POST',
      url: `orgs/${orgId}/members/${viewerId}/sessions/revoke`,
      token: admin.token,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ revoked: 1 });
    expect((await inject({ method: 'GET', url: 'auth/me', token: viewer.token })).statusCode).toBe(
      401,
    );
    expect(
      (await inject({ method: 'POST', url: 'auth/refresh', cookie: viewer.cookie })).statusCode,
    ).toBe(401);
    const audit = await app.get(PrismaService).client.auditLog.findFirst({
      where: { action: 'member.sessions_revoked', targetId: viewerId },
    });
    expect(audit).toMatchObject({ organizationId: orgId, actorUserId: adminId });

    // The owner outranks the administrator.
    const ownerId = (
      await app
        .get(PrismaService)
        .client.user.findUniqueOrThrow({ where: { email: 'owner@s.test' } })
    ).id;
    const upward = await inject({
      method: 'POST',
      url: `orgs/${orgId}/members/${ownerId}/sessions/revoke`,
      token: admin.token,
    });
    expect(upward.statusCode).toBe(403);
    expect((await inject({ method: 'GET', url: 'auth/me', token: owner.token })).statusCode).toBe(
      200,
    );
    // A user who is not a member of the organization does not exist there.
    const stranger = await inject({
      method: 'GET',
      url: `orgs/${orgId}/members/usr_nobody/sessions`,
      token: admin.token,
    });
    expect(stranger.statusCode).toBe(404);
  });
});
