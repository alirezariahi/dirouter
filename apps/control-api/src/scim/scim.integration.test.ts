/** SAML service provider and SCIM 2.0 provisioning (card 22.1). */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const MASTER_KEY = generateKey();

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('SAML and SCIM over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  let scimToken = '';
  let samlId = '';
  const http = () => app.getHttpAdapter().getInstance();
  const scim = (method: string, url: string, body?: unknown, token = scimToken) =>
    http().inject({
      method: method as 'GET',
      url: `/api/v1/scim/v2/${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}),
      },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

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
        PUBLIC_API_URL: 'http://admin.example.test',
        PUBLIC_DASHBOARD_URL: 'http://app.example.test',
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, scim_tokens, scim_users, scim_groups, sso_connections, organizations CASCADE',
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
            organizationName: 'Scim',
            name: 'O',
            email: 'owner@scim.example.com',
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

  // A throwaway IdP signing certificate.
  const dir = mkdtempSync(join(tmpdir(), 'dirouter-saml-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=idp.test',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');

  it('a SAML connection starts at the IdP and serves SP metadata; forged responses are refused', async () => {
    const created = await call('POST', 'sso', {
      name: 'Corp SAML',
      protocol: 'saml',
      issuer: 'http://idp.test/realms/corp',
      clientId: 'dirouter-sp',
      samlSsoUrl: 'http://idp.test/realms/corp/protocol/saml',
      samlCert: cert,
      allowedDomains: ['scim.example.com'],
      groupRoleMap: { 'dirouter-admins': 'ADMIN' },
    });
    expect(created.statusCode).toBe(201);
    samlId = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({
      protocol: 'saml',
      hasSamlCert: true,
      hasClientSecret: false,
      acsUrl: `http://admin.example.test/api/v1/auth/sso/saml/${samlId}/acs`,
    });
    expect(
      (
        await call('POST', 'sso', {
          ...created.json<object>(),
          name: 'Bad',
          protocol: 'saml',
          issuer: 'x',
          clientId: 'y',
          samlSsoUrl: 'http://idp.test/x',
          samlCert: 'nope',
          allowedDomains: ['a.test'],
        })
      ).statusCode,
    ).toBe(422);

    const started = await http().inject({
      method: 'POST',
      url: `/api/v1/auth/sso/${samlId}/start`,
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    const url = new URL(started.json<{ authorizationUrl: string }>().authorizationUrl);
    expect(url.origin + url.pathname).toBe('http://idp.test/realms/corp/protocol/saml');
    expect(url.searchParams.get('SAMLRequest')).toBeTruthy();
    const state = started.json<{ state: string }>().state;
    expect(url.searchParams.get('RelayState')).toBe(state);

    const metadata = await http().inject({
      method: 'GET',
      url: `/api/v1/auth/sso/saml/${samlId}/metadata`,
    });
    expect(metadata.headers['content-type']).toContain('samlmetadata+xml');
    expect(metadata.body).toContain('entityID="dirouter-sp"');
    expect(metadata.body).toContain(
      `Location="http://admin.example.test/api/v1/auth/sso/saml/${samlId}/acs"`,
    );

    const forged = Buffer.from(
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_x" Version="2.0" IssueInstant="${new Date().toISOString()}"><saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Subject><saml:NameID>owner@scim.example.com</saml:NameID></saml:Subject></saml:Assertion></samlp:Response>`,
    ).toString('base64');
    const acs = (form: Record<string, string>) =>
      http().inject({
        method: 'POST',
        url: `/api/v1/auth/sso/saml/${samlId}/acs`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(form).toString(),
      });
    expect((await acs({ SAMLResponse: forged, RelayState: state })).statusCode).toBe(401);
    expect((await acs({ SAMLResponse: forged, RelayState: 'unknown' })).statusCode).toBe(400);
  });

  it('SCIM tokens: owners create them, shown once; a bad token gets a SCIM error', async () => {
    const res = await call('POST', 'scim/tokens', { name: 'Keycloak' });
    expect(res.statusCode).toBe(201);
    scimToken = res.json<{ token: string }>().token;
    expect(scimToken).toMatch(/^scim_/);
    const list = (await call('GET', 'scim/tokens')).json<{ prefix: string; name: string }[]>();
    expect(list).toEqual([
      expect.objectContaining({ name: 'Keycloak', prefix: scimToken.slice(0, 12) }),
    ]);
    expect(JSON.stringify(list)).not.toContain(scimToken);
    const bad = await scim('GET', 'Users', undefined, 'scim_wrong');
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toMatchObject({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401',
    });
    expect((await scim('GET', 'ServiceProviderConfig')).json()).toMatchObject({
      patch: { supported: true },
    });
  });

  it('provisions users, maps groups to roles, deactivates with key revocation, and reactivates', async () => {
    const db = app.get(PrismaService).client;
    const created = await scim('POST', 'Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'alice@scim.example.com',
      externalId: 'kc-alice',
      name: { givenName: 'Alice', familyName: 'Lee' },
      emails: [{ value: 'Alice@scim.example.com', primary: true }],
      active: true,
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['content-type']).toContain('application/scim+json');
    const alice = created.json<{ id: string }>().id;
    expect(created.json()).toMatchObject({
      userName: 'alice@scim.example.com',
      displayName: 'Alice Lee',
      active: true,
    });
    expect(
      (await scim('POST', 'Users', { userName: 'alice@scim.example.com' })).json(),
    ).toMatchObject({ status: '409', scimType: 'uniqueness' });
    const found = await scim(
      'GET',
      `Users?filter=${encodeURIComponent('userName eq "ALICE@scim.example.com"')}`,
    );
    expect(found.json()).toMatchObject({ totalResults: 1, Resources: [{ id: alice }] });

    // An account outside this organization is not adopted.
    await db.user.create({
      data: { id: 'usr_outside', email: 'outsider@scim.example.com', name: 'O', passwordHash: 'x' },
    });
    expect(
      (await scim('POST', 'Users', { userName: 'outsider@scim.example.com' })).statusCode,
    ).toBe(409);

    const userId = (await db.scimUser.findUniqueOrThrow({ where: { id: alice } })).userId;
    const role = async () =>
      (
        await db.membership.findUnique({
          where: { userId_organizationId: { userId, organizationId: org } },
        })
      )?.role;
    expect(await role()).toBe('MEMBER');

    const group = await scim('POST', 'Groups', {
      displayName: 'dirouter-admins',
      members: [{ value: alice }],
    });
    expect(group.statusCode).toBe(201);
    const groupId = group.json<{ id: string }>().id;
    expect(await role()).toBe('ADMIN');
    await scim('PATCH', `Groups/${groupId}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'remove', path: `members[value eq "${alice}"]` }],
    });
    expect(await role()).toBe('MEMBER');
    await scim('PATCH', `Groups/${groupId}`, {
      Operations: [{ op: 'add', path: 'members', value: [{ value: alice }] }],
    });
    expect(await role()).toBe('ADMIN');

    // A key Alice created, and a session of hers.
    const project = (await call('POST', 'projects', { name: 'P' })).json<{ id: string }>().id;
    const key = (await call('POST', 'keys', { name: 'alice key', projectId: project })).json<{
      id: string;
    }>().id;
    await db.apiKey.update({ where: { id: key }, data: { createdById: userId } });
    await db.refreshToken.create({
      data: {
        id: 'rt_alice',
        userId,
        familyId: 'fam',
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const off = await scim('PATCH', `Users/${alice}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false } }],
    });
    expect(off.json()).toMatchObject({ active: false });
    expect(await role()).toBeUndefined();
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: key } })).status).toBe('REVOKED');
    expect(
      (await db.refreshToken.findUniqueOrThrow({ where: { id: 'rt_alice' } })).revokedAt,
    ).not.toBeNull();
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).isActive).toBe(false);
    const audit = await db.auditLog.findFirst({
      where: { action: 'scim.user_deactivated', targetId: userId },
    });
    expect(audit?.diff).toMatchObject({ revokedKeys: 1, accountDisabled: true });

    // Entra ID sends "True" as a string.
    await scim('PATCH', `Users/${alice}`, {
      Operations: [{ op: 'replace', path: 'active', value: 'True' }],
    });
    expect(await role()).toBe('ADMIN');
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).isActive).toBe(true);

    expect((await scim('DELETE', `Users/${alice}`)).statusCode).toBe(204);
    expect(await role()).toBeUndefined();
    expect((await scim('GET', `Users/${alice}`)).statusCode).toBe(404);
    expect((await scim('GET', `Groups/${groupId}`)).json()).toMatchObject({ members: [] });
  });

  it('owners are never deactivated through SCIM', async () => {
    const owner = await scim('POST', 'Users', { userName: 'owner@scim.example.com' });
    expect(owner.statusCode).toBe(201);
    const id = owner.json<{ id: string }>().id;
    const off = await scim('PATCH', `Users/${id}`, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(off.json()).toMatchObject({ status: '409', scimType: 'mutability' });
  });
});
