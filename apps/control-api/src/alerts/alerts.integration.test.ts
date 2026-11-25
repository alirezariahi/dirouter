/**
 * "Send test" on alert channels against real Postgres, Valkey and an SMTP listener: it is rate
 * limited per channel and per organization, an email test needs a verified sender, and the
 * subject never carries tenant text. `queue_length` rules belong to the platform organization.
 * Runs only with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL.
 */
import { generateKey, prefixedId } from '@dirouter/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { envSchema } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { type SmtpSink, startSmtpSink } from '../infra/smtp-sink.testing.js';
import { ValkeyService } from '../infra/valkey.service.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const PW = 'a-long-enough-password';
/** The limits of alerts.service.ts, written out so the test also runs against older code. */
const CHANNEL_TEST_LIMITS = { channelGapSeconds: 60, orgPerHour: 10 };

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('alert channel tests', () => {
  let app: NestFastifyApplication;
  let smtp: SmtpSink;
  let owner = '';
  let ownerId = '';
  let org = '';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/${url}`,
        headers: { authorization: `Bearer ${owner}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const db = () => app.get(PrismaService).client;
  const channel = async (name: string, type: string, config: Record<string, unknown>) => {
    const res = await call('POST', `orgs/${org}/alerts/channels`, { name, type, config });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const test = (id: string) => call('POST', `orgs/${org}/alerts/channels/${id}/test`);

  beforeAll(async () => {
    smtp = await startSmtpSink();
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
        SMTP_URL: smtp.url,
        SMTP_FROM: 'DiRouter <noreply@alerts.example.test>',
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await db().$executeRawUnsafe(
      'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, notification_channels, alert_rules, users, organizations CASCADE',
    );
    const valkey = app.get(ValkeyService).client;
    for (const pattern of ['dirouter:login:*', 'dirouter:alerts:*']) {
      const keys = await valkey.keys(pattern);
      if (keys.length > 0) await valkey.del(...keys);
    }
    owner = (
      await call('POST', 'auth/setup', {
        organizationName: 'Alerting',
        name: 'Owner',
        email: 'owner@alerts.example.test',
        password: PW,
      })
    ).json<{ accessToken: string }>().accessToken;
    const me = await db().user.findFirstOrThrow({ where: { email: 'owner@alerts.example.test' } });
    ownerId = me.id;
    org = (await db().organization.findFirstOrThrow()).id;
  });

  afterAll(async () => {
    await app.close();
    await smtp.close();
  });

  it('sends a test email with a fixed subject, at most once a minute per channel', async () => {
    const id = await channel('FREE MONEY click https://evil.example', 'email', {
      to: 'ops@alerts.example.test, other@alerts.example.test',
    });
    const first = await test(id);
    expect(first.json()).toEqual({ ok: true });
    const mail = smtp.to('ops@alerts.example.test').at(-1)?.raw ?? '';
    expect(mail).toContain('Subject: [DiRouter] Test alert from DiRouter\r\n');
    expect(mail).not.toContain('FREE MONEY');

    const again = await test(id);
    expect(again.statusCode).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(
      CHANNEL_TEST_LIMITS.channelGapSeconds,
    );
    expect(smtp.to('ops@alerts.example.test')).toHaveLength(1);
  });

  it(`stops an organization after ${String(CHANNEL_TEST_LIMITS.orgPerHour)} tests an hour`, async () => {
    // The email test above counted as one; webhook tests to a closed port count the same.
    const answers: number[] = [];
    for (let i = 0; i < CHANNEL_TEST_LIMITS.orgPerHour; i++) {
      const id = await channel(`hook ${String(i)}`, 'webhook', { url: 'http://127.0.0.1:9/' });
      answers.push((await test(id)).statusCode);
    }
    expect(answers.slice(0, -1).every((status) => status === 200)).toBe(true);
    expect(answers.at(-1)).toBe(429);
  });

  it('refuses an email test from a person whose address is not verified', async () => {
    const valkey = app.get(ValkeyService).client;
    const keys = await valkey.keys('dirouter:alerts:*');
    if (keys.length > 0) await valkey.del(...keys);
    const id = await channel('ops mail', 'email', { to: 'victim@alerts.example.test' });
    await db().user.update({ where: { id: ownerId }, data: { emailVerifiedAt: null } });
    try {
      const refused = await test(id);
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ code: string }>().code).toBe('email_not_verified');
      expect(smtp.to('victim@alerts.example.test')).toHaveLength(0);
    } finally {
      await db().user.update({ where: { id: ownerId }, data: { emailVerifiedAt: new Date() } });
    }
  });

  it('keeps queue_length rules to the platform organization', async () => {
    const tenant = await db().organization.create({
      data: { id: prefixedId('org'), name: 'Tenant', slug: 'tenant-alerts' },
    });
    await db().membership.create({
      data: { id: prefixedId('mem'), userId: ownerId, organizationId: tenant.id, role: 'OWNER' },
    });
    const rule = { name: 'queue', type: 'queue_length', threshold: 100 };
    const refused = await call('POST', `orgs/${tenant.id}/alerts/rules`, rule);
    expect(refused.statusCode).toBe(403);
    // Turning another rule into one is refused the same way.
    const latency = await call('POST', `orgs/${tenant.id}/alerts/rules`, {
      name: 'slow',
      type: 'latency',
      threshold: 1000,
    });
    expect(latency.statusCode).toBe(201);
    const id = latency.json<{ id: string }>().id;
    expect(
      (await call('PATCH', `orgs/${tenant.id}/alerts/rules/${id}`, { type: 'queue_length' }))
        .statusCode,
    ).toBe(403);
    expect((await call('POST', `orgs/${org}/alerts/rules`, rule)).statusCode).toBe(201);
  });
});
