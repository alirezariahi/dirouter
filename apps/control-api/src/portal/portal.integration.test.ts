/**
 * Self-service portal backend against real Postgres and Valkey (card 19.5): the public market,
 * email sign-up through the first key, and OIDC sign-in against an in-process identity provider.
 * Email verification (card 23.4) runs against a real SMTP listener that keeps what it receives.
 */
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { decodeBody, type SmtpSink, startSmtpSink } from '../infra/smtp-sink.testing.js';
import { ValkeyService } from '../infra/valkey.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('portal over HTTP', () => {
  let app: NestFastifyApplication;
  let operator = '';
  let platform = '';
  const idp = Fastify();
  let idpUrl = '';
  /** What the fake provider will put in the next id_token. */
  let nextIdentity: Record<string, unknown> = {};
  const codes = new Map<string, { nonce: string }>();
  let smtp: SmtpSink;

  /** The token of the newest verification link emailed to `email`. */
  const linkTo = (email: string) => {
    const body = decodeBody(smtp.to(email).at(-1)?.raw ?? '');
    const match = /https:\/\/portal\.example\.test\/verify-email\?token=([A-Za-z0-9_-]+)/.exec(
      body,
    );
    return match?.[1] ?? '';
  };
  const verify = (token: string) => inject('POST', 'portal/verify-email', { body: { token } });
  /** Signs up and returns the session token and the user's workspace. */
  const signupAndOrg = async (email: string, ip: string) => {
    const res = await signup(email, ip);
    expect(res.statusCode).toBe(201);
    const token = res.json<{ accessToken: string }>().accessToken;
    const org =
      (await inject('GET', 'auth/me', { token })).json<{ organizations: { id: string }[] }>()
        .organizations[0]?.id ?? '';
    const project = (await inject('GET', `orgs/${org}/projects`, { token }))
      .json<{ id: string; slug: string }[]>()
      .find((p) => p.slug === 'default');
    const createKey = () =>
      inject('POST', `orgs/${org}/keys`, { token, body: { name: 'k', projectId: project?.id } });
    const balance = async () =>
      (await inject('GET', `orgs/${org}/wallet`, { token })).json<{
        wallet: { balanceUsd: string };
      }>().wallet.balanceUsd;
    return { res, token, org, createKey, balance };
  };

  const inject = (
    method: string,
    url: string,
    opts: { token?: string; body?: unknown; cookie?: string; ip?: string } = {},
  ) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: method as 'GET',
        url: `/api/v1/${url}`,
        remoteAddress: opts.ip ?? '10.9.0.1',
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
        ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
      });
  const settings = (portal: Record<string, unknown>) =>
    inject('PUT', `orgs/${platform}/billing/settings`, {
      token: operator,
      body: { exchangeRates: {}, providers: [], portal },
    });
  const signup = (email: string, ip?: string) =>
    inject('POST', 'portal/signup', {
      body: { name: 'Dev', email, password: PW },
      ...(ip ? { ip } : {}),
    });

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    idp.get('/.well-known/openid-configuration', () => ({
      issuer: idpUrl,
      authorization_endpoint: `${idpUrl}/authorize`,
      token_endpoint: `${idpUrl}/token`,
      jwks_uri: `${idpUrl}/jwks`,
    }));
    idp.get('/jwks', () => ({ keys: [jwk] }));
    idp.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );
    idp.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
      const grant = codes.get(req.body.code ?? '');
      if (!grant) return reply.status(400).send({ error: 'invalid_grant' });
      codes.delete(req.body.code ?? '');
      const idToken = await new SignJWT({ nonce: grant.nonce, ...nextIdentity })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idpUrl)
        .setAudience('portal-client')
        .setSubject('subject-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return { id_token: idToken, access_token: 'x', token_type: 'Bearer' };
    });
    await idp.listen({ port: 0, host: '127.0.0.1' });
    const ia = idp.server.address();
    idpUrl = `http://127.0.0.1:${String(typeof ia === 'object' && ia ? ia.port : 0)}`;

    smtp = await startSmtpSink();
    app = await createApp(
      envSchema.parse({
        SMTP_URL: smtp.url,
        SMTP_FROM: 'DiRouter <noreply@portal.example.test>',
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'q'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
        PUBLIC_PORTAL_URL: 'https://portal.example.test',
        PORTAL_OIDC_ISSUER: idpUrl,
        PORTAL_OIDC_CLIENT_ID: 'portal-client',
        PORTAL_OIDC_CLIENT_SECRET: 'portal-secret',
        PORTAL_OIDC_NAME: 'Example ID',
      }),
    );
    const db = app.get(PrismaService).client;
    await db.$executeRawUnsafe(
      'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, models, providers, billing_settings, wallet_transactions, wallets, organizations CASCADE',
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const valkey = app.get(ValkeyService).client;
    const stale = [
      ...(await valkey.keys('portal:signups:*')),
      ...(await valkey.keys('portal:verify-*')),
    ];
    if (stale.length > 0) await valkey.del(...stale);
    operator = (
      await inject('POST', 'auth/setup', {
        body: {
          organizationName: 'Operator',
          name: 'O',
          email: 'portal-op@example.com',
          password: PW,
        },
      })
    ).json<{ accessToken: string }>().accessToken;
    platform =
      (await inject('GET', 'auth/me', { token: operator })).json<{
        organizations: { id: string }[];
      }>().organizations[0]?.id ?? '';
    const provider = (
      await inject('POST', `orgs/${platform}/providers`, {
        token: operator,
        body: { name: 'Up', type: 'openai', credentials: [{ name: 'k', secret: 'sk-x' }] },
      })
    ).json<{ id: string }>().id;
    for (const [slug, isPublic] of [
      ['shop/public', true],
      ['shop/private', false],
    ] as const)
      await inject('POST', `orgs/${platform}/models`, {
        token: operator,
        body: {
          providerId: provider,
          upstreamModel: slug,
          slug,
          isPublic,
          pricing: { inputPerMTok: '2', outputPerMTok: '8' },
          sale: { multiplier: '1.25' },
        },
      });
  });

  afterAll(async () => {
    await app.close();
    await idp.close();
    await smtp.close();
  });

  it('the market lists public models at their sale price, without signing in', async () => {
    const market = (await inject('GET', 'portal/market')).json<{
      models: { slug: string; price: Record<string, string> }[];
    }>();
    expect(market.models).toEqual([
      expect.objectContaining({
        slug: 'shop/public',
        price: { inputPerMTok: '2.50000000', outputPerMTok: '10.00000000' },
      }),
    ]);
  });

  it('sign-up is closed until the operator opens it', async () => {
    expect((await inject('GET', 'portal/config')).json()).toMatchObject({
      signupEnabled: false,
      passwordSignup: true,
      oidc: { enabled: true, name: 'Example ID' },
    });
    expect((await signup('closed@example.com')).statusCode).toBe(403);
    expect((await settings({ signupEnabled: true, welcomeCreditUsd: '1.5' })).statusCode).toBe(200);
  });

  it('a new user gets a prepaid workspace, verifies the email, then gets the welcome credit and a key', async () => {
    const res = await signup('dev@example.com');
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toContain('dr_refresh=');
    expect(res.json()).toMatchObject({ emailVerified: false, verificationEmailSent: true });
    const token = res.json<{ accessToken: string }>().accessToken;
    const me = (await inject('GET', 'auth/me', { token })).json<{
      emailVerified: boolean;
      organizations: { id: string; role: string }[];
    }>();
    expect(me.emailVerified).toBe(false);
    expect(me.organizations).toHaveLength(1);
    const org = me.organizations[0]?.id ?? '';
    expect(me.organizations[0]?.role).toBe('OWNER');
    const wallet = async () =>
      (await inject('GET', `orgs/${org}/wallet`, { token })).json<unknown>();
    // Unverified (23.4): a workspace, but no welcome credit and no keys.
    expect(await wallet()).toMatchObject({ prepaid: true, wallet: { balanceUsd: '0.00000000' } });
    const projects = (await inject('GET', `orgs/${org}/projects`, { token })).json<
      { id: string; slug: string }[]
    >();
    const project = projects.find((p) => p.slug === 'default');
    const createKey = () =>
      inject('POST', `orgs/${org}/keys`, {
        token,
        body: { name: 'first', projectId: project?.id },
      });
    const refused = await createKey();
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ code: string }>().code).toBe('email_not_verified');

    // The link arrives by SMTP, works once, and unlocks both.
    const mail = smtp.to('dev@example.com').at(-1);
    expect(mail?.raw).toContain('Subject: Confirm your email address for DiRouter');
    const link = linkTo('dev@example.com');
    expect(link.length).toBeGreaterThan(20);
    const stored = await app.get(PrismaService).client.emailVerification.findFirst({
      where: { user: { email: 'dev@example.com' } },
    });
    expect(stored?.tokenHash).not.toBe(link);
    const verified = await verify(link);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ verified: true, email: 'dev@example.com' });
    expect((await inject('GET', 'auth/me', { token })).json()).toMatchObject({
      emailVerified: true,
    });
    expect(await wallet()).toMatchObject({ wallet: { balanceUsd: '1.50000000' } });
    const key = await createKey();
    expect(key.statusCode).toBe(201);
    // Used links are refused, and the credit is never granted twice.
    const again = await verify(link);
    expect(again.statusCode).toBe(400);
    expect(again.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'verification_link_invalid',
      detail: 'This verification link has already been used',
    });
    expect(await wallet()).toMatchObject({ wallet: { balanceUsd: '1.50000000' } });
    // The customer cannot reach operator routes.
    expect((await inject('GET', `orgs/${platform}/billing/wallets`, { token })).statusCode).toBe(
      404,
    );
    expect((await signup('dev@example.com', '10.9.0.2')).statusCode).toBe(409);
  });

  it('expired, unknown and replaced links are refused', async () => {
    const user = await signupAndOrg('late@example.com', '10.9.0.4');
    const first = linkTo('late@example.com');
    await app.get(PrismaService).client.emailVerification.updateMany({
      where: { user: { email: 'late@example.com' } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await verify(first);
    expect(expired.statusCode).toBe(400);
    expect(expired.json<{ detail: string }>().detail).toContain('expired');
    expect((await verify('x'.repeat(43))).json<{ detail: string }>().detail).toBe(
      'This verification link is not valid',
    );
    expect((await user.createKey()).statusCode).toBe(403);
    expect(await user.balance()).toBe('0.00000000');

    // A new link replaces the old one and works.
    const resent = await inject('POST', 'portal/verify-email/resend', { token: user.token });
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toEqual({ sent: true });
    const second = linkTo('late@example.com');
    expect(second).not.toBe(first);
    expect((await verify(second)).statusCode).toBe(200);
    expect((await user.createKey()).statusCode).toBe(201);
    expect(await user.balance()).toBe('1.50000000');
    // Nothing left to resend for a verified address.
    expect(
      (await inject('POST', 'portal/verify-email/resend', { token: user.token })).statusCode,
    ).toBe(409);
  });

  it('resending is rate limited per user and needs a session', async () => {
    expect((await inject('POST', 'portal/verify-email/resend')).statusCode).toBe(401);
    const user = await signupAndOrg('again@example.com', '10.9.0.5');
    const valkey = app.get(ValkeyService).client;
    const resend = () => inject('POST', 'portal/verify-email/resend', { token: user.token });
    expect((await resend()).statusCode).toBe(200);
    // A second request inside the minimum gap is refused.
    const tooSoon = await resend();
    expect(tooSoon.statusCode).toBe(429);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      await valkey.del(`portal:verify-gap:${user.res.json<{ user: { id: string } }>().user.id}`);
      statuses.push((await resend()).statusCode);
    }
    // Three per hour in total (the first one above included).
    expect(statuses).toEqual([200, 200, 429]);
    expect(smtp.to('again@example.com')).toHaveLength(4);
  });

  it('sign-ups are rate limited per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await signup(`burst${String(i)}@example.com`, '10.9.0.3')).statusCode);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('OIDC: a verified email signs up, signs in again, and is refused without the browser binding', async () => {
    const start = async () => {
      const res = await inject('POST', 'portal/oidc/start');
      const url = new URL(res.json<{ authorizationUrl: string }>().authorizationUrl);
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://portal.example.test/oauth/callback',
      );
      const cookie = String(res.headers['set-cookie']).split(';')[0] ?? '';
      const code = `code-${String(Math.random())}`;
      codes.set(code, { nonce: url.searchParams.get('nonce') ?? '' });
      return { code, state: url.searchParams.get('state') ?? '', cookie };
    };
    const finish = (flow: { code: string; state: string; cookie: string }, cookie = flow.cookie) =>
      inject('GET', `portal/oidc/callback?code=${flow.code}&state=${flow.state}`, { cookie });

    nextIdentity = { email: 'Oidc@Example.com', email_verified: true, name: 'Oidc User' };
    const first = await finish(await start());
    expect(first.statusCode).toBe(200);
    // email_verified from the provider is enough (23.4): no link, credit and keys right away.
    const oidcToken = first.json<{ accessToken: string }>().accessToken;
    const oidcMe = (await inject('GET', 'auth/me', { token: oidcToken })).json<{
      emailVerified: boolean;
      organizations: { id: string }[];
    }>();
    expect(oidcMe.emailVerified).toBe(true);
    expect(smtp.to('oidc@example.com')).toHaveLength(0);
    const oidcOrg = oidcMe.organizations[0]?.id ?? '';
    expect(
      (await inject('GET', `orgs/${oidcOrg}/wallet`, { token: oidcToken })).json(),
    ).toMatchObject({ wallet: { balanceUsd: '1.50000000' } });
    const oidcProject = (await inject('GET', `orgs/${oidcOrg}/projects`, { token: oidcToken }))
      .json<{ id: string; slug: string }[]>()
      .find((p) => p.slug === 'default');
    expect(
      (
        await inject('POST', `orgs/${oidcOrg}/keys`, {
          token: oidcToken,
          body: { name: 'oidc', projectId: oidcProject?.id },
        })
      ).statusCode,
    ).toBe(201);
    const again = await finish(await start());
    expect(again.json<{ user: { id: string } }>().user.id).toBe(
      first.json<{ user: { id: string } }>().user.id,
    );
    expect((await finish(await start(), '')).statusCode).toBe(400);

    nextIdentity = { email: 'unverified@example.com', email_verified: false };
    expect((await finish(await start())).statusCode).toBe(401);
    // A password sign-up that never opened its link is verified by a vouched OIDC sign-in.
    const pending = await signupAndOrg('pending@example.com', '10.9.0.6');
    expect((await pending.createKey()).statusCode).toBe(403);
    nextIdentity = { email: 'pending@example.com', email_verified: true };
    expect((await finish(await start())).statusCode).toBe(200);
    expect((await pending.createKey()).statusCode).toBe(201);
    expect(await pending.balance()).toBe('1.50000000');
    // The operator's own account is not reachable through the public portal.
    nextIdentity = { email: 'portal-op@example.com', email_verified: true };
    expect((await finish(await start())).statusCode).toBe(403);
  });
});
