/**
 * Budgets, quota windows and the credential strategy of upstream providers (card 32.6): the API,
 * the snapshot, and the quota countdown on the health report.
 */
import { quotaWindowKey } from '@dirouter/contracts';
import { generateKey } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;

describe.skipIf(!DATABASE_URL || !VALKEY_URL)(
  'upstream budgets and quota windows over HTTP',
  () => {
    let app: NestFastifyApplication;
    let org = '';
    let token = '';
    let provider = '';
    let credentials: string[] = [];
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
          MASTER_KEY: generateKey(),
          KEY_PEPPER: 'q'.repeat(32),
          JWT_SECRET: 'j'.repeat(32),
          INTERNAL_TOKEN: 'i'.repeat(32),
          // No gateway: the health report only has what control-api knows itself.
          GATEWAY_INTERNAL_URL: 'http://127.0.0.1:9',
        }),
      );
      await app
        .get(PrismaService)
        .client.$executeRawUnsafe(
          'TRUNCATE refresh_tokens, memberships, audit_logs, users, providers, credentials, budgets, change_requests, organizations CASCADE',
        );
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      const http = app.getHttpAdapter().getInstance();
      token = (
        await http.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            organizationName: 'Plans',
            name: 'O',
            email: 'owner@plans.example.com',
            password: 'a-long-enough-password',
          },
        })
      ).json<{ accessToken: string }>().accessToken;
      org =
        (
          await http.inject({
            method: 'GET',
            url: '/api/v1/auth/me',
            headers: { authorization: `Bearer ${token}` },
          })
        ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
      const created = await call('POST', 'providers', {
        name: 'Coding plan',
        type: 'openai-compatible',
        baseUrl: 'https://plan.example.com/v1',
        credentials: [
          { name: 'seat-1', secret: 'sk-test-seat-one' },
          { name: 'seat-2', secret: 'sk-test-seat-two' },
        ],
      });
      expect(created.statusCode).toBe(201);
      const body = created.json<{ id: string; credentials: { id: string }[] }>();
      provider = body.id;
      credentials = body.credentials.map((c) => c.id);
    }, 120_000);

    afterAll(async () => {
      await app.close();
    });

    it('sets the strategy, a provider budget, and budgets and quota windows of a credential', async () => {
      const spend = await call('PUT', `providers/${provider}/spend`, {
        credentialStrategy: 'fill-first',
        budgets: [{ period: 'monthly', limitUsd: '500' }],
      });
      expect(spend.statusCode).toBe(200);
      expect(spend.json()).toMatchObject({
        credentialStrategy: 'fill-first',
        budgets: [expect.objectContaining({ period: 'monthly', limitUsd: '500' })],
      });
      const seat = await call(
        'PUT',
        `providers/${provider}/credentials/${credentials[0] ?? ''}/spend`,
        {
          budgets: [{ period: 'daily', limitUsd: '20' }],
          quotaWindows: [
            { id: '5h', hours: 5, limitRequests: 200 },
            { id: 'week', hours: 168, limitUsd: '100' },
          ],
        },
      );
      expect(seat.statusCode).toBe(200);
      expect(
        (
          await call('PUT', `providers/${provider}/credentials/${credentials[0] ?? ''}/spend`, {
            quotaWindows: [{ id: 'x', hours: 5 }],
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await call('PUT', `providers/${provider}/credentials/cred_unknown/spend`, { budgets: [] }))
          .statusCode,
      ).toBe(404);
      expect((await call('PUT', 'providers/prv_unknown/spend', { budgets: [] })).statusCode).toBe(
        404,
      );

      const snap = (await app.get(SnapshotService).build()).providers.find(
        (p) => p.id === provider,
      );
      expect(snap).toMatchObject({
        credentialStrategy: 'fill-first',
        budgets: [expect.objectContaining({ period: 'monthly', limitUsd: '500' })],
      });
      expect(snap?.credentials.find((c) => c.id === credentials[0])).toMatchObject({
        budgets: [expect.objectContaining({ period: 'daily', limitUsd: '20' })],
        quotaWindows: [
          { id: '5h', hours: 5, limitRequests: 200 },
          { id: 'week', hours: 168, limitUsd: '100' },
        ],
      });
      expect(snap?.credentials.find((c) => c.id === credentials[1])?.quotaWindows).toBeUndefined();
    });

    it('the health report counts down to the reset of each running window', async () => {
      const valkey = app.get(ValkeyService).client;
      const seat = credentials[0] ?? '';
      // The gateway counted 120 requests in a window that started two hours ago.
      await valkey.del(quotaWindowKey(seat, '5h'), quotaWindowKey(seat, 'week'));
      await valkey.hset(quotaWindowKey(seat, '5h'), 'requests', 120, 'tokens', 9000, 'usd', 0);
      await valkey.pexpire(quotaWindowKey(seat, '5h'), 3 * 3_600_000);
      const before = Date.now();
      const health = (await call('GET', 'health/runtime')).json<{
        providers: {
          id: string;
          credentials: {
            id: string;
            quotas: {
              id: string;
              resetAt: string | null;
              used: { requests: number };
              exhausted: boolean;
            }[];
          }[];
        }[];
      }>();
      const quotas = health.providers
        .find((p) => p.id === provider)
        ?.credentials.find((c) => c.id === seat)?.quotas;
      const fiveHours = quotas?.find((q) => q.id === '5h');
      expect(fiveHours).toMatchObject({ used: { requests: 120 }, exhausted: false });
      const resetIn = Date.parse(fiveHours?.resetAt ?? '') - before;
      expect(resetIn).toBeGreaterThan(3 * 3_600_000 - 5_000);
      expect(resetIn).toBeLessThanOrEqual(3 * 3_600_000 + 1_000);
      // A window without a request yet has no countdown.
      expect(quotas?.find((q) => q.id === 'week')).toMatchObject({
        resetAt: null,
        exhausted: false,
      });
    });
  },
);
