/** Provider plugins: listing, the terms gate and the audit trail (card 21.2). */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('provider plugins over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  let providerId = '';

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
    const dir = await mkdtemp(join(tmpdir(), 'dirouter-cp-plugins-'));
    const plugin = async (name: string, manifest: object, code = 'module.exports = {}') => {
      await mkdir(join(dir, name));
      await writeFile(
        join(dir, name, 'plugin.json'),
        JSON.stringify({ name, version: '1.0.0', ...manifest }),
      );
      await writeFile(join(dir, name, 'index.js'), code);
    };
    await plugin('plain', { displayName: 'Plain', defaultBaseUrl: 'https://plain.example.com/v1' });
    await plugin('risky', {
      displayName: 'Subscription bridge',
      termsWarning: { text: 'Using a subscription this way may break the provider terms.' },
    });
    await plugin('broken', { displayName: 'Broken', hosts: 'not-a-list' });
    await plugin('disabled', { displayName: 'Not enabled' });
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
        PLUGINS_DIR: dir,
        PLUGINS_ENABLED: 'plain, risky, broken',
      }),
    );
    await app
      .get(PrismaService)
      .client.$executeRawUnsafe(
        'TRUNCATE refresh_tokens, memberships, audit_logs, users, api_keys, projects, providers, credentials, organizations CASCADE',
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
            organizationName: 'Plugins',
            name: 'O',
            email: 'plugins@example.com',
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

  it('lists the enabled plugins with their terms warning; a broken manifest is reported', async () => {
    const res = await call('GET', 'providers/plugins');
    expect(res.statusCode).toBe(200);
    const list =
      res.json<{ name: string; status: string; termsWarning?: unknown; error?: string }[]>();
    expect(list.map((p) => [p.name, p.status])).toEqual([
      ['plain', 'available'],
      ['risky', 'available'],
      ['broken', 'failed'],
    ]);
    expect(list[1]?.termsWarning).toEqual({
      text: 'Using a subscription this way may break the provider terms.',
    });
    expect(list[2]?.error).toMatch(/hosts/);
  });

  it('creates a plugin provider; only enabled plugins are accepted', async () => {
    const plain = await call('POST', 'providers', {
      name: 'Plain',
      type: 'plugin',
      options: { plugin: 'plain', region: 'eu' },
    });
    expect(plain.statusCode).toBe(201);
    expect(plain.json()).toMatchObject({
      type: 'plugin',
      baseUrl: 'https://plain.example.com/v1',
      options: { plugin: 'plain', region: 'eu' },
    });
    for (const name of ['disabled', 'broken', 'nope'])
      expect(
        (
          await call('POST', 'providers', {
            name,
            type: 'plugin',
            baseUrl: 'https://x.test',
            options: { plugin: name },
          })
        ).statusCode,
      ).toBe(422);
  });

  it('a plugin with a terms warning needs explicit acceptance, recorded and audited', async () => {
    const refused = await call('POST', 'providers', {
      name: 'Risky',
      type: 'plugin',
      baseUrl: 'https://risky.example.com',
      // A client cannot mark the terms as accepted by itself.
      options: { plugin: 'risky', termsAcceptedAt: '2020-01-01T00:00:00Z' },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain('may break the provider terms');

    const accepted = await call('POST', 'providers', {
      name: 'Risky',
      type: 'plugin',
      baseUrl: 'https://risky.example.com',
      options: { plugin: 'risky' },
      acceptTerms: true,
    });
    expect(accepted.statusCode).toBe(201);
    providerId = accepted.json<{ id: string }>().id;
    const options = accepted.json<{ options: Record<string, string> }>().options;
    expect(options.termsAcceptedBy).toMatch(/^usr_/);
    expect(Date.parse(options.termsAcceptedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);

    // Editing other options keeps the acceptance; it cannot be forged or dropped by the client.
    const edited = await call('PATCH', `providers/${providerId}`, {
      options: { plugin: 'risky', extra: '1', termsAcceptedAt: '1999-01-01T00:00:00Z' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<{ options: Record<string, string> }>().options).toMatchObject({
      extra: '1',
      termsAcceptedAt: options.termsAcceptedAt,
    });

    const audit = await app.get(PrismaService).client.auditLog.findMany({
      where: { action: 'provider.terms_accepted', targetId: providerId },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.diff)).toContain('may break the provider terms');
  });
});
