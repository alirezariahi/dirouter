/**
 * Dashboard authentication against real Postgres and Valkey, over HTTP (card 3.4).
 * Runs only with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL.
 */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { REFRESH_COOKIE } from './auth.controller.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('dashboard auth over HTTP', () => {
  let app: NestFastifyApplication;
  const inject = (opts: {
    method: 'GET' | 'POST';
    url: string;
    body?: unknown;
    cookie?: string;
    token?: string;
    ip?: string;
  }) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: opts.method,
        url: `/api/v1/auth/${opts.url}`,
        remoteAddress: opts.ip ?? '10.0.0.1',
        headers: {
          // Like Traefik: TLS at the edge, the request reaches control-api with X-Forwarded-Proto.
          'x-forwarded-proto': 'https',
          ...(opts.cookie ? { cookie: `${REFRESH_COOKIE}=${opts.cookie}` } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
      });
  const refreshCookie = (res: { cookies: { name: string; value: string }[] }) =>
    res.cookies.find((c) => c.name === REFRESH_COOKIE)?.value ?? '';
  const owner = {
    organizationName: 'Acme Labs',
    name: 'Owner',
    email: 'Owner@Example.com',
    password: 'a-long-enough-password',
  };

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('the wizard creates the organization and owner once, then disables itself', async () => {
    expect((await inject({ method: 'GET', url: 'setup' })).json()).toEqual({ required: true });
    const [first, second] = await Promise.all([
      inject({ method: 'POST', url: 'setup', body: owner }),
      // Same user with different letter case: whichever wins, the final user is one and later tests do not depend on
      // the race winner (only one should get 201).
      inject({ method: 'POST', url: 'setup', body: { ...owner, email: 'OWNER@EXAMPLE.COM' } }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json()).toMatchObject({ code: 'setup_completed' });
    expect((await inject({ method: 'GET', url: 'setup' })).json()).toEqual({ required: false });
    const again = await inject({ method: 'POST', url: 'setup', body: owner });
    expect(again.statusCode).toBe(409);
    const db = app.get(PrismaService).client;
    expect(await db.user.count()).toBe(1);
    expect(await db.membership.findFirst()).toMatchObject({ role: 'OWNER' });
  });

  it('logs in with a case-insensitive email and sets a strict httpOnly refresh cookie', async () => {
    const res = await inject({
      method: 'POST',
      url: 'login',
      body: { email: 'owner@example.com', password: owner.password },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ accessToken: string; expiresIn: number }>();
    expect(body.expiresIn).toBe(900);
    const cookie = res.cookies.find((c) => c.name === REFRESH_COOKIE);
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/v1/auth',
    });
    const me = await inject({ method: 'GET', url: 'me', token: body.accessToken });
    expect(me.json()).toMatchObject({
      email: 'owner@example.com',
      organizations: [{ name: 'Acme Labs', slug: 'acme-labs', role: 'OWNER' }],
    });
    expect((await inject({ method: 'GET', url: 'me' })).statusCode).toBe(401);
  });

  it('a used refresh token cannot be used again and revokes the whole session', async () => {
    const login = await inject({
      method: 'POST',
      url: 'login',
      body: { email: owner.email, password: owner.password },
    });
    const first = refreshCookie(login);
    const rotated = await inject({ method: 'POST', url: 'refresh', cookie: first });
    expect(rotated.statusCode).toBe(200);
    const second = refreshCookie(rotated);
    expect(second).not.toBe(first);

    // The attacker resends the old token.
    const replay = await inject({ method: 'POST', url: 'refresh', cookie: first });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'refresh_token_reused' });
    // The real user's new token has also been revoked.
    const victim = await inject({ method: 'POST', url: 'refresh', cookie: second });
    expect(victim.statusCode).toBe(401);
  });

  it('two concurrent refreshes with one token: only one wins', async () => {
    const login = await inject({
      method: 'POST',
      url: 'login',
      body: { email: owner.email, password: owner.password },
    });
    const token = refreshCookie(login);
    const results = await Promise.all([
      inject({ method: 'POST', url: 'refresh', cookie: token }),
      inject({ method: 'POST', url: 'refresh', cookie: token }),
    ]);
    expect(results.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(1);
    expect(results.some((r) => r.statusCode === 401)).toBe(true);
  });

  it('10 failed logins lock the account temporarily, even with the right password', async () => {
    for (let i = 0; i < 9; i++) {
      const r = await inject({
        method: 'POST',
        url: 'login',
        ip: `10.1.0.${String(i)}`,
        body: { email: owner.email, password: 'wrong-password' },
      });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ code: 'invalid_credentials' });
    }
    const tenth = await inject({
      method: 'POST',
      url: 'login',
      body: { email: owner.email, password: 'wrong-password' },
    });
    expect(tenth.statusCode).toBe(429);
    expect(tenth.json()).toMatchObject({ code: 'login_locked' });
    expect(Number(tenth.headers['retry-after'])).toBeGreaterThan(800);
    const right = await inject({
      method: 'POST',
      url: 'login',
      body: { email: owner.email, password: owner.password },
    });
    expect(right.statusCode).toBe(429);
    // The other account is not locked; an anonymous caller gets the same response (without revealing that the user exists).
    const unknown = await inject({
      method: 'POST',
      url: 'login',
      ip: '10.2.0.1',
      body: { email: 'nobody@example.com', password: 'whatever-pass' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ code: 'invalid_credentials' });
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:acct:*');
    await app.get(ValkeyService).client.del(...keys);
  });

  it('changing the password revokes every refresh token and logout clears the session', async () => {
    const login = await inject({
      method: 'POST',
      url: 'login',
      body: { email: owner.email, password: owner.password },
    });
    const { accessToken } = login.json<{ accessToken: string }>();
    const token = refreshCookie(login);
    const wrong = await inject({
      method: 'POST',
      url: 'password',
      token: accessToken,
      body: { currentPassword: 'nope-nope-nope', newPassword: 'another-long-password' },
    });
    expect(wrong.statusCode).toBe(401);
    const changed = await inject({
      method: 'POST',
      url: 'password',
      token: accessToken,
      body: { currentPassword: owner.password, newPassword: 'another-long-password' },
    });
    expect(changed.statusCode).toBe(204);
    expect((await inject({ method: 'POST', url: 'refresh', cookie: token })).statusCode).toBe(401);
    const relogin = await inject({
      method: 'POST',
      url: 'login',
      body: { email: owner.email, password: 'another-long-password' },
    });
    expect(relogin.statusCode).toBe(200);
    const out = await inject({ method: 'POST', url: 'logout', cookie: refreshCookie(relogin) });
    expect(out.statusCode).toBe(204);
    expect(
      (await inject({ method: 'POST', url: 'refresh', cookie: refreshCookie(relogin) })).statusCode,
    ).toBe(401);
  });

  it('validates input and never stores the plain password', async () => {
    const bad = await inject({ method: 'POST', url: 'login', body: { email: 'not-an-email' } });
    expect(bad.statusCode).toBe(422);
    const user = await app.get(PrismaService).client.user.findFirst();
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user?.passwordHash).not.toContain('another-long-password');
  });

  it('over plain http in development the cookie is not Secure, so http dev sessions survive a reload', async () => {
    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '10.3.0.1',
        payload: { email: owner.email, password: 'another-long-password' },
      });
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === REFRESH_COOKIE)).toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(res.cookies.find((c) => c.name === REFRESH_COOKIE)?.secure).toBeFalsy();
  });
});
