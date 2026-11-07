/**
 * RBAC و ایزولاسیون سازمان‌ها روی Postgres و Valkey واقعی، از طریق HTTP (کارت ۳.۵).
 */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('organization RBAC over HTTP', () => {
  let app: NestFastifyApplication;
  const tokens: Record<string, string> = {};
  let orgA = '';
  let orgB = '';
  let teamB = '';
  const ids: Record<string, string> = {};

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token?: string,
    body?: unknown,
  ) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        remoteAddress: '10.9.0.1',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

  /** دعوت با نقش و پذیرش آن توسط کاربر تازه؛ access token کاربر را برمی‌گرداند. */
  async function join(by: string, org: string, email: string, role: string) {
    const inv = await call('POST', `orgs/${org}/invitations`, by, { email, role });
    expect(inv.statusCode).toBe(201);
    const { token } = inv.json<{ token: string }>();
    const acc = await call('POST', 'auth/invitations/accept', undefined, {
      token,
      name: email,
      password: PW,
    });
    expect(acc.statusCode).toBe(200);
    const body = acc.json<{ accessToken: string; user: { id: string } }>();
    ids[email] = body.user.id;
    return { access: body.accessToken, inviteToken: token };
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
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, projects, teams, users, organizations CASCADE',
      );
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);

    const setup = await call('POST', 'auth/setup', undefined, {
      organizationName: 'Org A',
      name: 'Owner A',
      email: 'owner-a@example.com',
      password: PW,
    });
    tokens.ownerA = setup.json<{ accessToken: string }>().accessToken;
    const me = await call('GET', 'auth/me', tokens.ownerA);
    orgA = me.json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';

    // سازمان دوم با مالک جدا، مستقیم در DB (setup فقط یک بار است).
    const db = app.get(PrismaService).client;
    orgB = 'org_b_test';
    await db.organization.create({ data: { id: orgB, name: 'Org B', slug: 'org-b' } });
    await db.user.create({
      data: {
        id: 'usr_owner_b',
        email: 'owner-b@example.com',
        name: 'Owner B',
        passwordHash: (await db.user.findFirstOrThrow()).passwordHash,
      },
    });
    await db.membership.create({
      data: { id: 'mem_b', userId: 'usr_owner_b', organizationId: orgB, role: 'OWNER' },
    });
    const login = await call('POST', 'auth/login', undefined, {
      email: 'owner-b@example.com',
      password: PW,
    });
    tokens.ownerB = login.json<{ accessToken: string }>().accessToken;
    teamB = (await call('POST', `orgs/${orgB}/teams`, tokens.ownerB, { name: 'Secret B' })).json<{
      id: string;
    }>().id;

    tokens.admin = (await join(tokens.ownerA, orgA, 'admin@example.com', 'ADMIN')).access;
    tokens.member = (await join(tokens.ownerA, orgA, 'member@example.com', 'MEMBER')).access;
    tokens.viewer = (await join(tokens.ownerA, orgA, 'viewer@example.com', 'VIEWER')).access;
  });

  afterAll(async () => {
    await app.close();
  });

  it('a VIEWER can read everything but cannot perform a single write', async () => {
    const team = (await call('POST', `orgs/${orgA}/teams`, tokens.ownerA, { name: 'Core' })).json<{
      id: string;
    }>();
    const project = (
      await call('POST', `orgs/${orgA}/projects`, tokens.ownerA, { name: 'Web', teamId: team.id })
    ).json<{ id: string }>();
    const inv = (
      await call('POST', `orgs/${orgA}/invitations`, tokens.ownerA, {
        email: 'later@example.com',
        role: 'MEMBER',
      })
    ).json<{ id: string }>();
    ids.team = team.id;
    ids.project = project.id;

    for (const path of ['', 'members', 'invitations', 'teams', 'projects']) {
      expect(
        (await call('GET', `orgs/${orgA}/${path}`.replace(/\/$/, ''), tokens.viewer)).statusCode,
      ).toBe(200);
    }
    const writes: [Parameters<typeof call>[0], string, unknown?][] = [
      ['PATCH', '', { name: 'Hacked' }],
      ['POST', 'teams', { name: 'X' }],
      ['PATCH', `teams/${team.id}`, { name: 'X' }],
      ['DELETE', `teams/${team.id}`],
      ['POST', 'projects', { name: 'X' }],
      ['PATCH', `projects/${project.id}`, { name: 'X' }],
      ['DELETE', `projects/${project.id}`],
      ['POST', 'invitations', { email: 'x@example.com', role: 'VIEWER' }],
      ['DELETE', `invitations/${inv.id}`],
      ['PATCH', `members/${ids['member@example.com'] ?? ''}`, { role: 'VIEWER' }],
      ['DELETE', `members/${ids['member@example.com'] ?? ''}`],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(
        method,
        `orgs/${orgA}/${path}`.replace(/\/$/, ''),
        tokens.viewer,
        body,
      );
      expect([method, path, res.statusCode]).toEqual([method, path, 403]);
    }
    const org = await call('GET', `orgs/${orgA}`, tokens.viewer);
    expect(org.json()).toMatchObject({ name: 'Org A', role: 'VIEWER' });
  });

  it('users of one organization cannot see or touch another organization', async () => {
    for (const path of ['', '/members', '/invitations', '/teams', '/projects']) {
      expect((await call('GET', `orgs/${orgB}${path}`, tokens.ownerA)).statusCode).toBe(404);
    }
    expect(
      (await call('POST', `orgs/${orgB}/teams`, tokens.ownerA, { name: 'X' })).statusCode,
    ).toBe(404);
    // شناسهٔ تیم سازمان B از مسیر سازمان A هم پیدا نمی‌شود.
    expect(
      (await call('PATCH', `orgs/${orgA}/teams/${teamB}`, tokens.ownerA, { name: 'X' })).statusCode,
    ).toBe(404);
    expect((await call('DELETE', `orgs/${orgA}/teams/${teamB}`, tokens.ownerA)).statusCode).toBe(
      404,
    );
    expect(
      (await call('POST', `orgs/${orgA}/projects`, tokens.ownerA, { name: 'P', teamId: teamB }))
        .statusCode,
    ).toBe(404);
    const teamsA = (await call('GET', `orgs/${orgA}/teams`, tokens.ownerA)).json<
      { id: string }[]
    >();
    expect(teamsA.map((t) => t.id)).not.toContain(teamB);
    expect((await call('GET', `orgs/${orgA}/teams`)).statusCode).toBe(401);
  });

  it('a MEMBER can create projects but not teams or members', async () => {
    expect(
      (await call('POST', `orgs/${orgA}/projects`, tokens.member, { name: 'Member project' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await call('POST', `orgs/${orgA}/teams`, tokens.member, { name: 'X' })).statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', `orgs/${orgA}/invitations`, tokens.member, {
          email: 'y@example.com',
          role: 'VIEWER',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('role rules: nobody grants above their own role and the last owner stays', async () => {
    const memberId = ids['member@example.com'] ?? '';
    expect(
      (await call('PATCH', `orgs/${orgA}/members/${memberId}`, tokens.admin, { role: 'OWNER' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', `orgs/${orgA}/invitations`, tokens.admin, {
          email: 'o@example.com',
          role: 'OWNER',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('PATCH', `orgs/${orgA}/members/${memberId}`, tokens.admin, { role: 'VIEWER' }))
        .statusCode,
    ).toBe(200);
    const ownerId = (await call('GET', 'auth/me', tokens.ownerA)).json<{ id: string }>().id;
    expect(
      (await call('PATCH', `orgs/${orgA}/members/${ownerId}`, tokens.admin, { role: 'MEMBER' }))
        .statusCode,
    ).toBe(403);
    const last = await call('PATCH', `orgs/${orgA}/members/${ownerId}`, tokens.ownerA, {
      role: 'ADMIN',
    });
    expect(last.statusCode).toBe(409);
  });

  it('invitation links are single-use, expire and never take over an existing account', async () => {
    const inv = await call('POST', `orgs/${orgA}/invitations`, tokens.ownerA, {
      email: 'new@example.com',
      role: 'VIEWER',
    });
    const { token, url } = inv.json<{ token: string; url: string }>();
    expect(url).toContain(`/invite/${token}`);
    expect(
      (
        await call('POST', 'auth/invitations/accept', undefined, {
          token,
          name: 'New',
          password: PW,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call('POST', 'auth/invitations/accept', undefined, {
          token,
          name: 'New',
          password: PW,
        })
      ).statusCode,
    ).toBe(404);

    const db = app.get(PrismaService).client;
    const old = await call('POST', `orgs/${orgA}/invitations`, tokens.ownerA, {
      email: 'late@example.com',
      role: 'VIEWER',
    });
    await db.invitation.update({
      where: { id: old.json<{ id: string }>().id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (
        await call('POST', 'auth/invitations/accept', undefined, {
          token: old.json<{ token: string }>().token,
          name: 'L',
          password: PW,
        })
      ).statusCode,
    ).toBe(404);

    // owner-b حساب دارد؛ دعوت به سازمان A بدون رمز خودش پذیرفته نمی‌شود.
    const forB = await call('POST', `orgs/${orgA}/invitations`, tokens.ownerA, {
      email: 'owner-b@example.com',
      role: 'VIEWER',
    });
    const tB = forB.json<{ token: string }>().token;
    expect(
      (
        await call('POST', 'auth/invitations/accept', undefined, {
          token: tB,
          password: 'not-the-password',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await call('POST', 'auth/invitations/accept', undefined, { token: tB, password: PW }))
        .statusCode,
    ).toBe(200);
  });

  it('every change is in the audit log of its own organization', async () => {
    const db = app.get(PrismaService).client;
    const actions = (await db.auditLog.findMany({ where: { organizationId: orgA } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'team.created',
        'project.created',
        'invitation.created',
        'invitation.accepted',
        'member.role_changed',
      ]),
    );
    expect(
      await db.auditLog.count({ where: { organizationId: orgB, action: 'project.created' } }),
    ).toBe(0);
  });
});
