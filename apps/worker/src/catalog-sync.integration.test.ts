/**
 * Catalog and price sync on real Postgres (card 27.5). The price source is a local HTTP server
 * serving a LiteLLM-format fixture; nothing reaches the internet.
 * Runs with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL set.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

import { approveCatalogProposal, createPrismaClient } from '@dirouter/db';
import { createLogger } from '@dirouter/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type CatalogSyncConfig, runCatalogSync } from './catalog-sync.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const ORG = 'org_catalog_it';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../packages/model-catalog/src/__fixtures__/litellm-sample.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>;

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('catalog sync on real Postgres', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 3 });
  let server: Server;
  let base = '';
  let document: unknown = fixture;
  let rebuilds = 0;

  const defaults = (over: Partial<CatalogSyncConfig> = {}): CatalogSyncConfig => ({
    enabled: true,
    sources: [`${base}/prices.json`],
    mode: 'manual',
    maxChangeFactor: 3,
    timeoutMs: 2_000,
    maxBytes: 1_000_000,
    ...over,
  });
  const sync = (over: Partial<CatalogSyncConfig> = {}) =>
    runCatalogSync({
      db,
      logger,
      defaults: defaults(over),
      requestRebuild: () => {
        rebuilds++;
        return Promise.resolve();
      },
    });
  const modelPrice = async (id: string) => {
    const m = await db.model.findUniqueOrThrow({ where: { id } });
    return [m.inputPrice.toString(), m.outputPrice.toString()];
  };
  const withPrice = (name: string, input: number, output: number) => ({
    ...fixture,
    [name]: { ...fixture[name], input_cost_per_token: input, output_cost_per_token: output },
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== '/prices.json') return res.writeHead(404).end();
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(typeof document === 'string' ? document : JSON.stringify(document));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  beforeEach(async () => {
    document = fixture;
    rebuilds = 0;
    await db.catalogPriceProposal.deleteMany({});
    await db.catalogModel.deleteMany({});
    await db.catalogSyncRun.deleteMany({});
    await db.catalogSyncSetting.deleteMany({});
    await db.organization.upsert({
      where: { id: ORG },
      create: { id: ORG, name: 'Catalog IT', slug: 'catalog-it' },
      update: {},
    });
    await db.model.deleteMany({ where: { organizationId: ORG } });
    await db.provider.upsert({
      where: { id: 'prv_catalog_it' },
      create: {
        id: 'prv_catalog_it',
        organizationId: ORG,
        slug: 'openai',
        name: 'OpenAI',
        type: 'OPENAI',
        baseUrl: 'https://api.openai.com/v1',
      },
      update: {},
    });
    // Two organization models on the bundled gpt-4o entry (2.50 / 10): one follows the catalog,
    // one was priced by hand.
    const model = (id: string, slug: string, priceOverride: boolean, input: string) =>
      db.model.create({
        data: {
          id,
          organizationId: ORG,
          providerId: 'prv_catalog_it',
          slug,
          upstreamModel: 'gpt-4o',
          inputPrice: input,
          outputPrice: '10',
          catalogKey: 'openai/gpt-4o',
          priceOverride,
        },
      });
    await model('mdl_follow', 'openai/gpt-4o', false, '2.5');
    await model('mdl_manual', 'mine/gpt-4o', true, '1.75');
  });

  afterAll(async () => {
    await db.catalogPriceProposal.deleteMany({});
    await db.catalogModel.deleteMany({});
    await db.catalogSyncRun.deleteMany({});
    await db.organization.delete({ where: { id: ORG } }).catch(() => undefined);
    await db.$disconnect();
    await new Promise((r) => server.close(r));
  });

  it('adds a new model without a release; a price change waits for approval in manual mode', async () => {
    const result = await sync();
    expect(result).toMatchObject({ status: 'ok', proposed: expect.any(Number) as number });
    // A model the bundled catalog does not have is now in the catalog.
    const added = await db.catalogModel.findUnique({ where: { key: 'openai/gpt-5.5-preview' } });
    expect(added).toMatchObject({ provider: 'openai', upstreamModel: 'gpt-5.5-preview' });
    expect(added?.pricing).toEqual({ inputPerMTok: '1.25', outputPerMTok: '10' });
    // Gemini 2.5 Pro gains a context tier: that is a price change too, so it is proposed.
    const gemini = await db.catalogPriceProposal.findFirstOrThrow({
      where: { catalogKey: 'gemini/gemini-2.5-pro' },
    });
    expect((gemini.proposedPricing as { tiers?: unknown[] }).tiers).toEqual([
      { aboveInputTokens: 200_000, inputPerMTok: '2.5', outputPerMTok: '15' },
    ]);

    // gpt-4o: 2.50/10 bundled → 3/12 in the source. The catalog entry keeps the price in force.
    const proposal = await db.catalogPriceProposal.findFirstOrThrow({
      where: { catalogKey: 'openai/gpt-4o' },
    });
    expect(proposal).toMatchObject({ status: 'pending', reason: 'manual_mode' });
    expect(proposal.proposedPricing).toMatchObject({ inputPerMTok: '3', outputPerMTok: '12' });
    const entry = await db.catalogModel.findUniqueOrThrow({ where: { key: 'openai/gpt-4o' } });
    expect(entry.pricing).toMatchObject({ inputPerMTok: '2.50', outputPerMTok: '10.00' });
    expect(entry.deprecationDate?.toISOString().slice(0, 10)).toBe('2027-03-31');
    // Request cost is unchanged: the organization model still has the old price.
    expect(await modelPrice('mdl_follow')).toEqual(['2.5', '10']);
    expect(rebuilds).toBe(0);

    // Running again does not ask twice.
    await sync();
    expect(await db.catalogPriceProposal.count({ where: { catalogKey: 'openai/gpt-4o' } })).toBe(1);

    // Approval puts it into force for models that follow the catalog, not for the hand-priced one.
    const approved = await approveCatalogProposal(db, proposal.id, 'usr_admin');
    expect(approved).toEqual({ catalogKey: 'openai/gpt-4o', appliedModels: 1 });
    expect(await modelPrice('mdl_follow')).toEqual(['3', '12']);
    expect(await modelPrice('mdl_manual')).toEqual(['1.75', '10']);
    const after = await db.catalogModel.findUniqueOrThrow({ where: { key: 'openai/gpt-4o' } });
    expect(after.pricing).toMatchObject({ inputPerMTok: '3', outputPerMTok: '12' });
    expect(await approveCatalogProposal(db, proposal.id, 'usr_admin')).toBeUndefined();
  });

  it('does not propose a rejected price again, and supersedes a stale proposal', async () => {
    await sync();
    const first = await db.catalogPriceProposal.findFirstOrThrow({
      where: { catalogKey: 'openai/gpt-4o' },
    });
    await db.catalogPriceProposal.update({ where: { id: first.id }, data: { status: 'rejected' } });
    await sync();
    expect(await db.catalogPriceProposal.count({ where: { catalogKey: 'openai/gpt-4o' } })).toBe(1);

    document = withPrice('gpt-4o', 3.5e-6, 1.4e-5);
    await sync();
    const pending = await db.catalogPriceProposal.findFirstOrThrow({
      where: { catalogKey: 'openai/gpt-4o', status: 'pending' },
    });
    expect(pending.proposedPricing).toMatchObject({ inputPerMTok: '3.5' });
    // The source goes back to the price in force: the pending proposal is moot.
    document = withPrice('gpt-4o', 2.5e-6, 1e-5);
    await sync();
    expect(
      (await db.catalogPriceProposal.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('superseded');
  });

  it('applies small changes at once in automatic mode and holds large ones', async () => {
    await db.catalogSyncSetting.create({ data: { id: 'global', settings: { mode: 'auto' } } });
    const result = await sync();
    expect(result.repriced).toBeGreaterThan(0);
    expect(await modelPrice('mdl_follow')).toEqual(['3', '12']);
    expect(await modelPrice('mdl_manual')).toEqual(['1.75', '10']);
    expect(rebuilds).toBe(1);

    // ×10 is above the factor of 3: held for an admin even in automatic mode.
    document = withPrice('gpt-4o', 3e-5, 1.2e-4);
    await sync();
    const held = await db.catalogPriceProposal.findFirstOrThrow({
      where: { catalogKey: 'openai/gpt-4o', status: 'pending' },
    });
    expect(held.reason).toBe('large_change');
    expect(await modelPrice('mdl_follow')).toEqual(['3', '12']);
  });

  it('keeps the last good catalog when the source is unreachable, broken or truncated', async () => {
    await sync();
    const before = await db.catalogModel.count();

    const offline = await sync({ sources: ['http://127.0.0.1:9/prices.json'] });
    expect(offline.status).toBe('failed');
    expect(offline.error).toMatch(/127\.0\.0\.1:9/);

    document = '{"not json';
    expect((await sync()).status).toBe('failed');
    document = { only: { litellm_provider: 'nobody' } };
    expect((await sync()).status).toBe('failed');

    expect(await db.catalogModel.count()).toBe(before);
    expect(await db.catalogModel.count({ where: { removedAt: { not: null } } })).toBe(0);
    expect(await modelPrice('mdl_follow')).toEqual(['2.5', '10']);
    const runs = await db.catalogSyncRun.findMany({ orderBy: { startedAt: 'asc' } });
    expect(runs.map((r) => r.status)).toEqual(['ok', 'failed', 'failed', 'failed']);
  });

  it('marks models the source dropped, refuses a truncated source, and can be switched off', async () => {
    // 25 synthetic models so the truncation guard (≥ 20 synced) is armed.
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [
        `synthetic-${String(i)}`,
        {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
      ]),
    );
    document = { ...fixture, ...many };
    await sync();
    // Dropping two is fine: they are marked, not deleted.
    const fewer = { ...(document as object) };
    delete (fewer as Record<string, unknown>)['synthetic-0'];
    delete (fewer as Record<string, unknown>)['synthetic-1'];
    document = fewer;
    expect((await sync()).removed).toBe(2);
    const gone = await db.catalogModel.findUniqueOrThrow({ where: { key: 'openai/synthetic-0' } });
    expect(gone.removedAt).not.toBeNull();
    // A source that suddenly lists almost nothing is refused.
    document = fixture;
    const truncated = await sync();
    expect(truncated.status).toBe('failed');
    expect(truncated.error).toMatch(/truncated/);
    expect(await db.catalogModel.count({ where: { removedAt: { not: null } } })).toBe(2);

    await db.catalogSyncSetting.create({ data: { id: 'global', settings: { enabled: false } } });
    expect((await sync()).status).toBe('disabled');
  });
});
