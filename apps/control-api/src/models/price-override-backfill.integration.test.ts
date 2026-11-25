/**
 * Migration 20261125200000_review_hardening on a database that went through catalog sync
 * (20261125160000_catalog_sync), where every catalog model got `price_override = false`, hand-priced
 * ones included. Afterwards a model follows the catalog only if its prices are exactly those of its
 * synced catalog entry; the rest are marked as priced by hand so no sync reprices them silently.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPrismaClient } from '@dirouter/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ADMIN_URL = process.env.INTEGRATION_DATABASE_URL;
const ROOT = resolve(import.meta.dirname, '../../../..');
const PRISMA = join(ROOT, 'packages/db/node_modules/.bin/prisma');
const CATALOG_SYNC = '20261125160000_catalog_sync';

const sql = (url: string, statement: string) =>
  execFileSync(PRISMA, ['db', 'execute', '--url', url, '--stdin'], {
    input: statement,
    cwd: join(ROOT, 'packages/db'),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const deploy = (url: string, schema: string) =>
  execFileSync(PRISMA, ['migrate', 'deploy', '--schema', schema], {
    cwd: join(ROOT, 'packages/db'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

describe.skipIf(!ADMIN_URL)('catalog price override backfill', () => {
  const name = `dirouter_backfill_${String(Date.now())}`;
  const url = (ADMIN_URL ?? '').replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  let overrides = new Map<string, boolean>();

  beforeAll(async () => {
    sql(ADMIN_URL ?? '', `CREATE DATABASE "${name}"`);
    // The schema as it was right after catalog sync: every migration up to and including it.
    const old = mkdtempSync(join(tmpdir(), 'dirouter-catalog-sync-'));
    cpSync(join(ROOT, 'packages/db/prisma'), old, { recursive: true });
    for (const entry of readdirSync(join(old, 'migrations')))
      if (/^\d{14}_/.test(entry) && entry > CATALOG_SYNC)
        rmSync(join(old, 'migrations', entry), { recursive: true });
    deploy(url, join(old, 'schema.prisma'));

    const before = "'2026-11-01T10:00:00Z'";
    sql(
      url,
      `
      INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES
        ('org_bf', 'Backfill', 'backfill', ${before}, now());
      INSERT INTO providers (id, organization_id, slug, name, type, base_url, created_at, updated_at) VALUES
        ('prv_bf', 'org_bf', 'openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', ${before}, now());
      INSERT INTO catalog_models (key, provider, upstream_model, pricing, source, updated_at) VALUES
        ('openai/synced', 'openai', 'synced',
          '{"inputPerMTok":"2.5","outputPerMTok":"10","cacheReadPerMTok":"1.25","batchDiscount":"0.5"}', 'litellm', now()),
        ('openai/tiered', 'openai', 'tiered',
          '{"inputPerMTok":"1","outputPerMTok":"4","tiers":[{"aboveInputTokens":200000,"inputPerMTok":"2","outputPerMTok":"8"}]}', 'litellm', now()),
        ('openai/odd', 'openai', 'odd', '{"inputPerMTok":"1e-6","outputPerMTok":"4"}', 'litellm', now());
      INSERT INTO models (id, organization_id, provider_id, slug, upstream_model, input_price, output_price,
          cache_read_price, batch_discount, pricing_tiers, catalog_key, price_override, created_at, updated_at) VALUES
        -- Prices exactly the catalog's (decimal scale differs): keeps following the catalog.
        ('mdl_same', 'org_bf', 'prv_bf', 'a', 'synced', 2.50000000, 10, 1.25, 0.5, NULL, 'openai/synced', false, ${before}, now()),
        -- Priced by hand before catalog sync existed.
        ('mdl_hand', 'org_bf', 'prv_bf', 'b', 'synced', 2, 10, 1.25, 0.5, NULL, 'openai/synced', false, ${before}, now()),
        ('mdl_cache', 'org_bf', 'prv_bf', 'c', 'synced', 2.5, 10, NULL, 0.5, NULL, 'openai/synced', false, ${before}, now()),
        -- Same tiers: follows; tiers dropped by hand: priced by hand.
        ('mdl_tiers', 'org_bf', 'prv_bf', 'd', 'tiered', 1, 4, NULL, NULL,
          '[{"inputPerMTok":"2","outputPerMTok":"8","aboveInputTokens":200000}]', 'openai/tiered', false, ${before}, now()),
        ('mdl_notier', 'org_bf', 'prv_bf', 'e', 'tiered', 1, 4, NULL, NULL, NULL, 'openai/tiered', false, ${before}, now()),
        -- Only in the bundled catalog, or a catalog price SQL cannot read: cannot compare, so safe.
        ('mdl_bundled', 'org_bf', 'prv_bf', 'f', 'x', 3, 12, NULL, NULL, NULL, 'anthropic/bundled', false, ${before}, now()),
        ('mdl_odd', 'org_bf', 'prv_bf', 'g', 'odd', 0.000001, 4, NULL, NULL, NULL, 'openai/odd', false, ${before}, now()),
        -- Not a catalog model, or already marked: untouched.
        ('mdl_plain', 'org_bf', 'prv_bf', 'h', 'own', 9, 9, NULL, NULL, NULL, NULL, false, ${before}, now()),
        ('mdl_marked', 'org_bf', 'prv_bf', 'i', 'synced', 2, 10, NULL, NULL, NULL, 'openai/synced', true, ${before}, now()),
        -- Created after catalog sync: the API already set its flag.
        ('mdl_new', 'org_bf', 'prv_bf', 'j', 'synced', 2, 10, NULL, NULL, NULL, 'openai/synced', false, now() + interval '1 minute', now());
      `,
    );

    // Every migration since.
    deploy(url, join(ROOT, 'packages/db/prisma/schema.prisma'));
    const db = createPrismaClient({ databaseUrl: url, maxConnections: 1 });
    try {
      const rows = await db.model.findMany({ select: { id: true, priceOverride: true } });
      overrides = new Map(rows.map((row) => [row.id, row.priceOverride]));
    } finally {
      await db.$disconnect();
    }
  }, 180_000);

  afterAll(() => {
    sql(ADMIN_URL ?? '', `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });

  it('marks hand-priced catalog models as overridden and leaves catalog-priced ones following', () => {
    expect(Object.fromEntries(overrides)).toEqual({
      mdl_same: false,
      mdl_hand: true,
      mdl_cache: true,
      mdl_tiers: false,
      mdl_notier: true,
      mdl_bundled: true,
      mdl_odd: true,
      mdl_plain: false,
      mdl_marked: true,
      mdl_new: false,
    });
  });
});
