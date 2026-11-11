/**
 * Provider and credential against real Postgres and Valkey, over HTTP (card 3.6). The gateway is replaced with a
 * fake server that records the probe request (the real probe is tested in the gateway tests).
 */
import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';

import { createLogger, decrypt, generateKey, parseKeyring } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';
const SECRET = 'sk-live-SUPERSECRET-9876';
const SECRET2 = 'sk-rotated-OTHERSECRET-5555';
const MASTER = generateKey();

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('providers and credentials over HTTP', () => {
  let app: NestFastifyApplication;
  let gateway: Server;
  const probes: { provider: { credentials: { secret: string }[] } }[] = [];
  const logs: string[] = [];
  let token = '';
  let viewer = '';
  let org = '';
  let providerId = '';

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    t = token,
    body?: unknown,
  ) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        remoteAddress: '10.8.0.1',
        headers: t ? { authorization: `Bearer ${t}` } : {},
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        probes.push(JSON.parse(raw) as (typeof probes)[number]);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok: true,
            status: 200,
            latencyMs: 42,
            models: [
              {
                id: 'gpt-4.1',
                catalog: {
                  key: 'openai/gpt-4.1',
                  contextWindow: 1047576,
                  pricing: { inputPerMTok: '2.00', outputPerMTok: '8.00' },
                },
              },
              { id: 'gpt-new-model' },
            ],
          }),
        );
      });
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const ga = gateway.address();
    const env = envSchema.parse({
      NODE_ENV: 'test',
      LOG_LEVEL: 'debug',
      DATABASE_URL,
      VALKEY_URL,
      MASTER_KEY: MASTER,
      KEY_PEPPER: 'p'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
      GATEWAY_INTERNAL_URL: `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`,
    });
    // All logs are captured to check for secret leaks.
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logs.push(chunk.toString());
        cb();
      },
    });
    app = await createApp(
      env,
      createLogger({ service: 'test', level: 'debug', destination: sink }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, credentials, models, providers, projects, teams, users, organizations CASCADE',
      );
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    const setup = await call('POST', 'auth/setup', '', {
      organizationName: 'Prov Org',
      name: 'O',
      email: 'o@example.com',
      password: PW,
    });
    token = setup.json<{ accessToken: string }>().accessToken;
    org =
      (await call('GET', 'auth/me')).json<{ organizations: { id: string }[] }>().organizations[0]
        ?.id ?? '';
    const inv = (
      await call('POST', `orgs/${org}/invitations`, token, {
        email: 'v@example.com',
        role: 'VIEWER',
      })
    ).json<{ token: string }>();
    viewer = (
      await call('POST', 'auth/invitations/accept', '', {
        token: inv.token,
        name: 'V',
        password: PW,
      })
    ).json<{ accessToken: string }>().accessToken;
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => gateway.close(r));
  });

  it('creates a provider with an encrypted credential and only ever shows ••••last4', async () => {
    const res = await call('POST', `orgs/${org}/providers`, token, {
      name: 'OpenAI Main',
      type: 'openai',
      proxyUrl: 'socks5h://user:proxypass@10.0.0.5:1080',
      timeouts: { connectMs: 3000 },
      credentials: [{ name: 'primary', secret: SECRET, weight: 2 }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      baseUrl: string;
      proxyUrl: string;
      credentials: { id: string; secret: string; weight: number }[];
    }>();
    providerId = body.id;
    expect(body.baseUrl).toBe('https://api.openai.com/v1');
    expect(body.credentials[0]).toMatchObject({ secret: '••••9876', weight: 2 });
    expect(body.proxyUrl).not.toContain('proxypass');
    for (const r of [
      res,
      await call('GET', `orgs/${org}/providers`),
      await call('GET', `orgs/${org}/providers/${providerId}`),
    ]) {
      expect(r.body).not.toContain('SUPERSECRET');
      expect(r.body).not.toContain('proxypass');
      expect(r.body).not.toContain('secretEnc');
    }
    const row = await app
      .get(PrismaService)
      .client.credential.findFirstOrThrow({ where: { providerId } });
    expect(row.secretEnc).toMatch(/^v\d+\./);
    expect(row.secretEnc).not.toContain('SUPERSECRET');
    expect(decrypt(parseKeyring(MASTER), row.secretEnc, row.id)).toBe(SECRET);
  });

  it('rotates a secret and adds, disables and removes credentials', async () => {
    const credId =
      (await call('GET', `orgs/${org}/providers/${providerId}`)).json<{
        credentials: { id: string }[];
      }>().credentials[0]?.id ?? '';
    const rotated = await call(
      'PATCH',
      `orgs/${org}/providers/${providerId}/credentials/${credId}`,
      token,
      { secret: SECRET2, status: 'DISABLED' },
    );
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({
      credentials: [{ secret: '••••5555', status: 'DISABLED' }],
    });
    const added = await call('POST', `orgs/${org}/providers/${providerId}/credentials`, token, {
      name: 'second',
      secret: 'sk-second-1111',
    });
    expect(added.json<{ credentials: unknown[] }>().credentials).toHaveLength(2);
    const second = added.json<{ credentials: { id: string }[] }>().credentials[1]?.id ?? '';
    expect(
      (await call('DELETE', `orgs/${org}/providers/${providerId}/credentials/${second}`))
        .statusCode,
    ).toBe(204);
    await call('PATCH', `orgs/${org}/providers/${providerId}/credentials/${credId}`, token, {
      status: 'ACTIVE',
    });
  });

  it('the connection test returns the result and latency and sends only ciphertext to the gateway', async () => {
    const res = await call('POST', `orgs/${org}/providers/${providerId}/test`, token, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 200, latencyMs: 42, modelCount: 2 });
    const sent = probes.at(-1)?.provider.credentials[0]?.secret ?? '';
    expect(sent).toMatch(/^v\d+\./);
    expect(JSON.stringify(probes)).not.toContain('OTHERSECRET');
  });

  it('discovery suggests models that are not in the organization catalog yet', async () => {
    await app.get(PrismaService).client.model.create({
      data: {
        id: 'mdl_known',
        organizationId: org,
        providerId,
        slug: 'openai/gpt-4.1',
        upstreamModel: 'gpt-4.1',
        inputPrice: '2',
        outputPrice: '8',
      },
    });
    const res = await call('POST', `orgs/${org}/providers/${providerId}/discover`);
    expect(res.json()).toMatchObject({
      ok: true,
      models: [
        {
          upstreamModel: 'gpt-4.1',
          inCatalog: true,
          suggested: false,
          catalog: { key: 'openai/gpt-4.1' },
        },
        { upstreamModel: 'gpt-new-model', inCatalog: false, suggested: true },
      ],
    });
  });

  it('a VIEWER sees providers but cannot change or probe them; other orgs get 404', async () => {
    expect((await call('GET', `orgs/${org}/providers`, viewer)).statusCode).toBe(200);
    expect(
      (await call('POST', `orgs/${org}/providers`, viewer, { name: 'x', type: 'openai' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `orgs/${org}/providers/${providerId}/test`, viewer, {})).statusCode,
    ).toBe(403);
    expect((await call('GET', `orgs/other_org/providers/${providerId}`)).statusCode).toBe(404);
  });

  it('validates input', async () => {
    expect(
      (await call('POST', `orgs/${org}/providers`, token, { name: 'Az', type: 'azure-openai' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call('POST', `orgs/${org}/providers`, token, {
          name: 'p',
          type: 'openai',
          proxyUrl: 'ftp://x',
        })
      ).statusCode,
    ).toBe(422);
  });

  it('no secret appears in any log line or in the audit log', async () => {
    const all = logs.join('\n');
    expect(logs.length).toBeGreaterThan(5);
    for (const s of ['SUPERSECRET', 'OTHERSECRET', 'sk-second-1111', 'proxypass'])
      expect(all).not.toContain(s);
    const audit = JSON.stringify(await app.get(PrismaService).client.auditLog.findMany());
    for (const s of ['SUPERSECRET', 'OTHERSECRET', 'sk-second-1111', 'proxypass'])
      expect(audit).not.toContain(s);
    expect(audit).toContain('credential.rotated');
  });
});
