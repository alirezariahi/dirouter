/**
 * Effective catalog, price proposals and organization overrides over HTTP (card 27.5), against
 * real Postgres and Valkey. The rows the worker's sync job would write are inserted directly; the
 * job itself is tested in apps/worker.
 */
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
const PW = 'a-long-enough-password';
const SOURCE = 'https://mirror.example.test/prices.json';

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('catalog sync over HTTP', () => {
  let app: NestFastifyApplication;
  let token = '';
  let org = '';
  let provider = '';

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, body?: unknown) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: `/api/v1/orgs/${org}/${url}`,
        remoteAddress: '10.6.0.2',
        headers: { authorization: `Bearer ${token}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      });
  const db = () => app.get(PrismaService).client;
  const clean = async () => {
    await db().catalogPriceProposal.deleteMany({});
    await db().catalogModel.deleteMany({});
    await db().catalogSyncRun.deleteMany({});
    await db().catalogSyncSetting.deleteMany({});
  };
  const snapshotModel = async (id: string) =>
    (await app.get(SnapshotService).build()).models.find((m) => m.id === id);

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
    await clean();
    const keys = await app.get(ValkeyService).client.keys('dirouter:login:*');
    if (keys.length > 0) await app.get(ValkeyService).client.del(...keys);
    const inject = app.getHttpAdapter().getInstance();
    token = (
      await inject.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          organizationName: 'Catalog Org',
          name: 'O',
          email: 'c@example.com',
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
    await clean();
    await app.close();
  });

  it('a new model in the source is in the catalog without a release, and models can use it', async () => {
    await db().catalogModel.create({
      data: {
        key: 'openai/gpt-5.5-preview',
        provider: 'openai',
        upstreamModel: 'gpt-5.5-preview',
        contextWindow: 400_000,
        pricing: { inputPerMTok: '1.25', outputPerMTok: '10' },
        capabilities: { tools: true, reasoning: true },
        deprecationDate: new Date('2027-06-30'),
        source: SOURCE,
      },
    });
    await db().catalogSyncRun.create({
      data: {
        id: 'csr_it_1',
        status: 'ok',
        sources: [SOURCE],
        mode: 'manual',
        finishedAt: new Date(),
      },
    });
    const catalog = (await call('GET', 'catalog')).json<{
      version: string;
      models: { key: string; source: string }[];
    }>();
    expect(catalog.version).toMatch(/^\d{4}\.\d{2}\.\d{2}\+sync\./);
    expect(catalog.models.find((m) => m.key === 'openai/gpt-5.5-preview')?.source).toBe(SOURCE);
    // Bundled entries are still there.
    expect(catalog.models.find((m) => m.key === 'openai/gpt-4.1')?.source).toBe('bundled');

    const created = await call('POST', 'models', {
      providerId: provider,
      upstreamModel: 'gpt-5.5-preview',
      catalogKey: 'openai/gpt-5.5-preview',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      pricing: { inputPerMTok: '1.25', outputPerMTok: '10' },
      contextWindow: 400_000,
      deprecationDate: '2027-06-30',
      priceOverride: false,
    });
    const inSnapshot = await snapshotModel(created.json<{ id: string }>().id);
    expect(inSnapshot?.deprecationDate).toBe('2027-06-30');
  });

  it('carries context tiers to the snapshot the gateway prices from', async () => {
    await db().catalogModel.create({
      data: {
        key: 'openai/tiered',
        provider: 'openai',
        upstreamModel: 'tiered',
        pricing: {
          inputPerMTok: '1.25',
          outputPerMTok: '10',
          tiers: [{ aboveInputTokens: 200_000, inputPerMTok: '2.5', outputPerMTok: '15' }],
          batchDiscount: '0.5',
        },
        source: SOURCE,
      },
    });
    const created = await call('POST', 'models', {
      providerId: provider,
      upstreamModel: 'tiered',
      catalogKey: 'openai/tiered',
    });
    const id = created.json<{ id: string }>().id;
    expect((await snapshotModel(id))?.pricing).toEqual({
      inputPerMTok: '1.25',
      outputPerMTok: '10',
      tiers: [{ aboveInputTokens: 200_000, inputPerMTok: '2.5', outputPerMTok: '15' }],
      batchDiscount: '0.5',
    });
  });

  it('in manual mode a price change does not reach request costs until an admin approves it', async () => {
    const follow = (
      await call('POST', 'models', {
        providerId: provider,
        upstreamModel: 'gpt-4.1',
        catalogKey: 'openai/gpt-4.1',
      })
    ).json<{ id: string }>().id;
    const own = (
      await call('POST', 'models', {
        providerId: provider,
        upstreamModel: 'gpt-4.1',
        slug: 'mine/gpt-4.1',
        catalogKey: 'openai/gpt-4.1',
        pricing: { inputPerMTok: '1.5' },
      })
    ).json<{ id: string; priceOverride: boolean }>();
    expect(own.priceOverride).toBe(true);

    // What the worker writes when the source says 3/9: the entry keeps the price in force.
    const bundled = { inputPerMTok: '2.00', outputPerMTok: '8.00', cacheReadPerMTok: '0.50' };
    await db().catalogModel.create({
      data: {
        key: 'openai/gpt-4.1',
        provider: 'openai',
        upstreamModel: 'gpt-4.1',
        pricing: bundled,
        source: SOURCE,
      },
    });
    await db().catalogPriceProposal.createMany({
      data: [
        {
          id: 'cpp_it_up',
          catalogKey: 'openai/gpt-4.1',
          source: SOURCE,
          currentPricing: bundled,
          proposedPricing: { inputPerMTok: '3', outputPerMTok: '9', cacheReadPerMTok: '0.75' },
          changeFactor: '1.5',
          reason: 'manual_mode',
        },
        {
          id: 'cpp_it_other',
          catalogKey: 'openai/gpt-5.5-preview',
          source: SOURCE,
          proposedPricing: { inputPerMTok: '99', outputPerMTok: '99' },
          reason: 'manual_mode',
        },
      ],
    });

    // Until approval the gateway snapshot (request cost) keeps the old price.
    expect((await snapshotModel(follow))?.pricing).toMatchObject({
      inputPerMTok: '2',
      outputPerMTok: '8',
    });
    const status = (await call('GET', 'catalog-sync')).json<{ pendingProposals: number }>();
    expect(status.pendingProposals).toBe(2);
    const listed = (await call('GET', 'catalog-sync/proposals?status=pending')).json<
      { id: string }[]
    >();
    expect(listed.map((p) => p.id).sort()).toEqual(['cpp_it_other', 'cpp_it_up']);

    const approved = await call('POST', 'catalog-sync/proposals/cpp_it_up/approve');
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved', appliedModels: 1 });
    expect((await snapshotModel(follow))?.pricing).toMatchObject({
      inputPerMTok: '3',
      outputPerMTok: '9',
      cacheReadPerMTok: '0.75',
    });
    // The organization's own price is kept.
    expect((await snapshotModel(own.id))?.pricing.inputPerMTok).toBe('1.5');
    // Decided proposals cannot be decided again.
    expect((await call('POST', 'catalog-sync/proposals/cpp_it_up/reject')).statusCode).toBe(404);

    const rejected = await call('POST', 'catalog-sync/proposals/cpp_it_other/reject');
    expect(rejected.json()).toMatchObject({ status: 'rejected' });
    const preview = (await call('GET', 'models')).json<
      { catalogKey: string; pricing: { inputPerMTok: string } }[]
    >();
    expect(
      preview.find((m) => m.catalogKey === 'openai/gpt-5.5-preview')?.pricing.inputPerMTok,
    ).toBe('1.25');

    // The org's sync button skips the hand-priced model; followCatalog brings it back.
    await call('POST', 'models/sync-catalog');
    expect((await snapshotModel(own.id))?.pricing.inputPerMTok).toBe('1.5');
    const back = await call('PATCH', `models/${own.id}`, { followCatalog: true });
    expect(back.json()).toMatchObject({ priceOverride: false, pricing: { inputPerMTok: '3' } });
    expect(
      (await call('PATCH', `models/${own.id}`, { pricing: { inputPerMTok: '4' } })).json(),
    ).toMatchObject({
      catalogKey: 'openai/gpt-4.1',
      priceOverride: true,
    });
  });

  it('stores sync settings and queues a run for the worker', async () => {
    const saved = await call('PUT', 'catalog-sync/settings', {
      enabled: true,
      sources: [SOURCE],
      mode: 'auto',
      maxChangeFactor: 2,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      enabled: true,
      sources: [SOURCE],
      mode: 'auto',
      maxChangeFactor: 2,
    });
    // An empty list goes back to the environment default; other fields stay.
    const reset = await call('PUT', 'catalog-sync/settings', { sources: [] });
    expect(reset.json()).toEqual({ enabled: true, mode: 'auto', maxChangeFactor: 2 });
    expect(
      (await call('PUT', 'catalog-sync/settings', { sources: ['ftp://x.test/p.json'] })).statusCode,
    ).toBe(422);

    const run = await call('POST', 'catalog-sync/run');
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ queued: true });
    const runs = (await call('GET', 'catalog-sync')).json<{ runs: { id: string }[] }>().runs;
    expect(runs.map((r) => r.id)).toContain('csr_it_1');
  });
});
