/** Catalog, model, alias, and combo against real Postgres and Valkey, over HTTP (card 3.8). */
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

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('models, aliases and combos over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  let provider = '';
  const m: Record<string, string> = {};
  let combo = '';

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/orgs/${org}/${url}`,
        remoteAddress: '10.6.0.1',
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });

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
        'TRUNCATE refresh_tokens, invitations, memberships, audit_logs, budgets, api_keys, combo_targets, combos, model_aliases, credentials, models, providers, projects, teams, users, organizations CASCADE',
      );
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    const inject = app.getHttpAdapter().getInstance();
    token = (
      await inject.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          organizationName: 'Models Org',
          name: 'O',
          email: 'm@example.com',
          password: PW,
        },
      })
    ).json<{ accessToken: string }>().accessToken;
    org =
      (
        await inject.inject({
          method: 'GET',
          url: '/api/v1/auth/me',
          headers: { authorization: `Bearer ${token}` },
        })
      ).json<{ organizations: { id: string }[] }>().organizations[0]?.id ?? '';
    provider = (
      await call('POST', 'providers', {
        name: 'OpenAI',
        type: 'openai',
        credentials: [{ name: 'k', secret: 'sk-x' }],
      })
    ).json<{ id: string }>().id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the versioned price catalog', async () => {
    const res = await call('GET', 'catalog');
    const body = res.json<{ version: string; models: { key: string }[] }>();
    expect(body.version).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
    expect(body.models.map((x) => x.key)).toContain('openai/gpt-4.1');
  });

  it('creates models, filling price and context from the catalog', async () => {
    const fromCatalog = await call('POST', 'models', {
      providerId: provider,
      upstreamModel: 'gpt-4.1',
      catalogKey: 'openai/gpt-4.1',
    });
    expect(fromCatalog.statusCode).toBe(201);
    expect(fromCatalog.json()).toMatchObject({
      slug: 'openai/gpt-4.1',
      contextWindow: 1047576,
      pricing: { inputPerMTok: '2', outputPerMTok: '8', cacheReadPerMTok: '0.5' },
      catalogKey: 'openai/gpt-4.1',
    });
    m.a = fromCatalog.json<{ id: string }>().id;
    for (const name of ['mini', 'nano']) {
      const r = await call('POST', 'models', {
        providerId: provider,
        upstreamModel: `gpt-4.1-${name}`,
        pricing: { inputPerMTok: '0.1', outputPerMTok: '0.4' },
      });
      expect(r.statusCode).toBe(201);
      m[name] = r.json<{ id: string }>().id;
    }
    expect(
      (await call('POST', 'models', { providerId: provider, upstreamModel: 'no-price' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call('POST', 'models', {
          providerId: 'prv_other_org',
          upstreamModel: 'x',
          pricing: { inputPerMTok: '1', outputPerMTok: '1' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('a combo with three targets is created and validated', async () => {
    const ok = await call('POST', 'combos', {
      slug: 'smart',
      strategy: 'priority',
      targets: [{ modelId: m.a }, { modelId: m.mini }, { modelId: m.nano }],
      fallbackOn: ['rate_limit', 'server', 'timeout'],
      retryMaxAttempts: 3,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      slug: 'smart',
      targets: [
        { modelId: m.a, order: 0 },
        { modelId: m.mini, order: 1 },
        { modelId: m.nano, order: 2 },
      ],
      fallbackOn: ['rate_limit', 'server', 'timeout'],
      retryMaxAttempts: 3,
    });
    combo = ok.json<{ id: string }>().id;
    const dup = await call('POST', 'combos', {
      slug: 'dup',
      targets: [{ modelId: m.a }, { modelId: m.a }],
    });
    expect(dup.statusCode).toBe(422);
    expect(dup.json<{ detail: string }>().detail).toContain('duplicate');
    const missing = await call('POST', 'combos', {
      slug: 'missing',
      targets: [{ modelId: m.a }, { modelId: 'mdl_nope' }],
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json<{ detail: string }>().detail).toContain('unknown model');
    expect(
      (
        await call('POST', 'combos', {
          slug: 'badclass',
          targets: [{ modelId: m.a }],
          fallbackOn: ['nonsense'],
        })
      ).statusCode,
    ).toBe(422);
    const weighted = await call('PATCH', `combos/${combo}`, {
      strategy: 'weighted',
      targets: [
        { modelId: m.mini, weight: 3 },
        { modelId: m.nano, weight: 1 },
      ],
    });
    expect(weighted.json()).toMatchObject({
      strategy: 'weighted',
      targets: [{ weight: 3 }, { weight: 1 }],
    });
  });

  it('aliases point to a model or a combo, and names never collide', async () => {
    const a = await call('POST', 'aliases', { slug: 'gpt-best', comboId: combo });
    expect(a.json()).toMatchObject({ slug: 'gpt-best', target: { kind: 'combo', comboId: combo } });
    expect((await call('POST', 'aliases', { slug: 'smart', modelId: m.a })).statusCode).toBe(409);
    expect(
      (await call('POST', 'aliases', { slug: 'both', modelId: m.a, comboId: combo })).statusCode,
    ).toBe(422);
    expect(
      (await call('POST', 'combos', { slug: 'gpt-best', targets: [{ modelId: m.a }] })).statusCode,
    ).toBe(409);
    // A model in use and a combo with an alias are not deleted.
    expect((await call('DELETE', `models/${m.mini}`)).statusCode).toBe(409);
    expect((await call('DELETE', `combos/${combo}`)).statusCode).toBe(409);
  });

  it('price catalog updates apply without a migration', async () => {
    const db = app.get(PrismaService).client;
    // Old price in the DB; the new catalog (a versioned JSON file) corrects it.
    await db.model.update({
      where: { id: m.a },
      data: { inputPrice: '9.99', contextWindow: 1000 },
    });
    const sync = await call('POST', 'models/sync-catalog');
    expect(sync.json()).toMatchObject({ updated: 1 });
    expect((await call('GET', `models/${m.a}`)).json()).toMatchObject({
      pricing: { inputPerMTok: '2' },
      contextWindow: 1047576,
    });
    expect((await call('POST', 'models/sync-catalog')).json()).toMatchObject({ updated: 0 });
    // A manual price no longer follows the catalog.
    const manual = await call('PATCH', `models/${m.a}`, { pricing: { inputPerMTok: '1.5' } });
    expect(manual.json()).toMatchObject({ catalogKey: null, pricing: { inputPerMTok: '1.5' } });
  });
});
