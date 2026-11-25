/**
 * Upstream balance refresh and display data (card 32.9) against real Postgres and Valkey. The
 * gateway is a fake that answers `/internal/providers/balance` (the real lookup against the mock
 * provider's balance APIs is tested in the gateway).
 */
import { createServer, type Server } from 'node:http';

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

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('upstream balances over HTTP', () => {
  let app: NestFastifyApplication;
  let gateway: Server;
  const sent: { provider: { id: string; credentials: { id: string; secret: string }[] } }[] = [];
  let answer: (body: (typeof sent)[number]) => unknown = () => ({ kind: null, balances: [] });
  let token = '';
  let org = '';

  const call = (method: 'GET' | 'POST', url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

  beforeAll(async () => {
    gateway = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as (typeof sent)[number];
        sent.push(body);
        res
          .writeHead(req.url === '/internal/providers/balance' ? 200 : 404, {
            'content-type': 'application/json',
          })
          .end(JSON.stringify(answer(body)));
      });
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const ga = gateway.address();
    app = await createApp(
      envSchema.parse({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL,
        VALKEY_URL,
        MASTER_KEY: generateKey(),
        KEY_PEPPER: 'p'.repeat(32),
        JWT_SECRET: 'j'.repeat(32),
        INTERNAL_TOKEN: 'i'.repeat(32),
        GATEWAY_INTERNAL_URL: `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`,
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, credentials, models, providers, projects, teams, users, organizations, alert_rules, notification_channels CASCADE',
      );
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    token = (
      await call('POST', 'auth/setup', {
        organizationName: 'Balance Org',
        name: 'O',
        email: 'b@example.com',
        password: PW,
      })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (await call('GET', 'auth/me')).json<{ organizations: { id: string }[] }>().organizations[0]
        ?.id ?? '';
  });

  afterAll(async () => {
    await app.close();
    await new Promise((r) => gateway.close(r));
  });

  it('refreshes, stores and shows the balance of each credential; a failed lookup keeps the amount', async () => {
    const created = await call('POST', `orgs/${org}/providers`, {
      name: 'OpenRouter',
      type: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      options: { preset: 'openrouter' },
      credentials: [{ name: 'main', secret: 'or-test-credential-0001' }],
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json<{
      id: string;
      balanceKind: string;
      credentials: { id: string; balance: unknown }[];
    }>();
    expect(provider.balanceKind).toBe('openrouter');
    expect(provider.credentials[0]?.balance).toBeNull();
    const credentialId = provider.credentials[0]?.id ?? '';

    answer = (body) => ({
      kind: 'openrouter',
      balances: body.provider.credentials.map((c) => ({
        providerId: body.provider.id,
        credentialId: c.id,
        kind: 'openrouter',
        ok: true,
        amount: '12.5',
        currency: 'USD',
        checkedAt: '2026-11-25T10:00:00.000Z',
      })),
    });
    const refreshed = await call('POST', `orgs/${org}/providers/${provider.id}/balance`);
    expect(refreshed.statusCode).toBe(200);
    expect(
      refreshed.json<{ credentials: { balance: unknown }[] }>().credentials[0]?.balance,
    ).toEqual({
      kind: 'openrouter',
      ok: true,
      amount: '12.5',
      currency: 'USD',
      error: null,
      checkedAt: '2026-11-25T10:00:00.000Z',
    });
    // Only the ciphertext goes to the gateway.
    expect(sent.at(-1)?.provider.credentials[0]?.secret).toMatch(/^v\d+\./);
    expect(JSON.stringify(sent)).not.toContain('or-test-credential-0001');

    answer = (body) => ({
      kind: 'openrouter',
      balances: [
        {
          providerId: body.provider.id,
          credentialId,
          kind: 'openrouter',
          ok: false,
          error: 'HTTP 401: invalid key',
          checkedAt: '2026-11-25T11:00:00.000Z',
        },
      ],
    });
    await call('POST', `orgs/${org}/providers/${provider.id}/balance`);
    const listed = (await call('GET', `orgs/${org}/providers`)).json<
      { id: string; credentials: { balance: Record<string, unknown> }[] }[]
    >();
    expect(listed.find((p) => p.id === provider.id)?.credentials[0]?.balance).toMatchObject({
      ok: false,
      amount: '12.5',
      error: 'HTTP 401: invalid key',
      checkedAt: '2026-11-25T11:00:00.000Z',
    });
  });

  it('refuses a provider without a balance API', async () => {
    const plain = (
      await call('POST', `orgs/${org}/providers`, {
        name: 'Groq',
        type: 'openai-compatible',
        baseUrl: 'https://api.groq.com/openai/v1',
        options: { preset: 'groq' },
      })
    ).json<{ id: string; balanceKind: string | null }>();
    expect(plain.balanceKind).toBeNull();
    answer = () => ({ kind: null, balances: [] });
    expect((await call('POST', `orgs/${org}/providers/${plain.id}/balance`)).statusCode).toBe(400);
  });

  it('accepts upstream_balance_low alert rules, with a threshold', async () => {
    expect(
      (
        await call('POST', `orgs/${org}/alerts/rules`, {
          name: 'low',
          type: 'upstream_balance_low',
        })
      ).statusCode,
    ).toBe(422);
    const rule = await call('POST', `orgs/${org}/alerts/rules`, {
      name: 'low',
      type: 'upstream_balance_low',
      threshold: 5,
    });
    expect(rule.statusCode).toBe(201);
    expect(rule.json()).toMatchObject({ type: 'upstream_balance_low', threshold: '5' });
  });
});
