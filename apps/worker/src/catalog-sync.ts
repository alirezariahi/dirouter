/**
 * Catalog and price sync job (card 27.5).
 *
 * Reads one or more price sources (LiteLLM's public list by default, or an internal mirror),
 * validates them, diffs them against the current catalog (the bundled catalog overlaid with earlier
 * syncs) and writes the result:
 * - a new model is added to the catalog right away (it costs nothing until a model uses it);
 * - a price change of an existing entry becomes a proposal for an admin (manual mode), or is put
 *   into force at once (automatic mode) unless it is larger than `maxChangeFactor`;
 * - organization models priced by hand (`price_override`) are never repriced.
 *
 * A source that cannot be fetched or parsed changes nothing: the last good catalog stays, and the
 * gateway never depends on the source at all (it prices from its config snapshot).
 */
import type { Prisma, PrismaClient } from '@dirouter/db';
import { repriceCatalogModels } from '@dirouter/db';
// Sub-path imports: the root entry also loads the tokenizer, which the worker image does not ship.
import { type CatalogEntry, catalog } from '@dirouter/model-catalog/catalog';
import {
  diffCatalog,
  mergeSources,
  type ParsedSource,
  parseCatalogSource,
  samePricing,
  shrinkError,
} from '@dirouter/model-catalog/sync';
import { type Logger, prefixedId } from '@dirouter/shared';
import { z } from 'zod';

export const CATALOG_SYNC_LOCK = 482_907;

export const CatalogSyncSettings = z.object({
  enabled: z.boolean().optional(),
  sources: z.array(z.url()).max(5).optional(),
  mode: z.enum(['manual', 'auto']).optional(),
  maxChangeFactor: z.number().min(1).max(1000).optional(),
});
export type CatalogSyncSettings = z.infer<typeof CatalogSyncSettings>;

export interface CatalogSyncConfig {
  enabled: boolean;
  sources: string[];
  mode: 'manual' | 'auto';
  maxChangeFactor: number;
  timeoutMs: number;
  /** Largest source document accepted (bytes). */
  maxBytes: number;
}

/** Admin settings stored in the database win over the environment defaults. */
export function resolveSyncConfig(
  defaults: CatalogSyncConfig,
  stored: unknown,
  logger?: Logger,
): CatalogSyncConfig {
  const parsed = CatalogSyncSettings.safeParse(stored ?? {});
  if (!parsed.success) {
    logger?.warn(
      { issues: parsed.error.issues.slice(0, 3) },
      'stored catalog sync settings invalid',
    );
    return defaults;
  }
  const s = parsed.data;
  return {
    ...defaults,
    ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
    ...(s.sources && s.sources.length > 0 ? { sources: s.sources } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    ...(s.maxChangeFactor !== undefined ? { maxChangeFactor: s.maxChangeFactor } : {}),
  };
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** Fetches and parses one source with a timeout and a size cap. */
export async function fetchSource(
  url: string,
  options: { timeoutMs: number; maxBytes: number; fetch?: FetchLike },
): Promise<ParsedSource> {
  const doFetch = options.fetch ?? ((u, init) => fetch(u, init));
  const response = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > options.maxBytes)
    throw new Error(`source larger than ${String(options.maxBytes)} bytes`);
  const text = await response.text();
  if (Buffer.byteLength(text) > options.maxBytes)
    throw new Error(`source larger than ${String(options.maxBytes)} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('source is not valid JSON');
  }
  return parseCatalogSource(json);
}

export interface CatalogSyncResult {
  runId: string;
  status: 'ok' | 'failed' | 'disabled';
  added: number;
  updated: number;
  repriced: number;
  proposed: number;
  removed: number;
  skipped: number;
  error?: string;
}

const toJson = (value: unknown) => value as Prisma.InputJsonValue;
const asDate = (day: string | undefined) => (day ? new Date(`${day}T00:00:00Z`) : null);

function rowToEntry(row: {
  key: string;
  provider: string;
  upstreamModel: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: unknown;
  capabilities: unknown;
  deprecationDate: Date | null;
  mode: string | null;
}): CatalogEntry {
  return {
    key: row.key,
    provider: row.provider,
    upstreamModel: row.upstreamModel,
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
    pricing: row.pricing as CatalogEntry['pricing'],
    capabilities: row.capabilities as CatalogEntry['capabilities'],
    ...(row.deprecationDate
      ? { deprecationDate: row.deprecationDate.toISOString().slice(0, 10) }
      : {}),
    ...(row.mode ? { mode: row.mode } : {}),
  };
}

/** Row data for a catalog entry with a given price (the current one, or the new one). */
const entryData = (entry: CatalogEntry, pricing: CatalogEntry['pricing'], source: string) => ({
  provider: entry.provider,
  upstreamModel: entry.upstreamModel,
  contextWindow: entry.contextWindow ?? null,
  maxOutputTokens: entry.maxOutputTokens ?? null,
  pricing: toJson(pricing),
  capabilities: toJson(entry.capabilities),
  deprecationDate: asDate(entry.deprecationDate),
  mode: entry.mode ?? null,
  source,
  removedAt: null,
});

export interface CatalogSyncDeps {
  db: PrismaClient;
  logger: Logger;
  defaults: CatalogSyncConfig;
  fetch?: FetchLike;
  /** Asks control-api to rebuild the gateway snapshot after organization models were repriced. */
  requestRebuild?: () => Promise<unknown>;
}

export async function runCatalogSync(deps: CatalogSyncDeps): Promise<CatalogSyncResult> {
  const { db, logger } = deps;
  const stored = await db.catalogSyncSetting.findUnique({ where: { id: 'global' } });
  const config = resolveSyncConfig(deps.defaults, stored?.settings, logger);
  const runId = prefixedId('csr');
  const result: CatalogSyncResult = {
    runId,
    status: 'ok',
    added: 0,
    updated: 0,
    repriced: 0,
    proposed: 0,
    removed: 0,
    skipped: 0,
  };
  const finish = async (status: CatalogSyncResult['status'], error?: string) => {
    result.status = status;
    if (error) result.error = error.slice(0, 1000);
    await db.catalogSyncRun.create({
      data: {
        id: runId,
        status,
        sources: config.sources,
        mode: config.mode,
        added: result.added,
        updated: result.updated,
        repriced: result.repriced,
        proposed: result.proposed,
        removed: result.removed,
        skipped: result.skipped,
        error: result.error ?? null,
        finishedAt: new Date(),
      },
    });
    // Keep the newest 500 runs.
    const old = await db.catalogSyncRun.findMany({
      orderBy: { startedAt: 'desc' },
      skip: 500,
      select: { id: true },
    });
    if (old.length > 0)
      await db.catalogSyncRun.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
    return result;
  };

  if (!config.enabled || config.sources.length === 0) return finish('disabled');

  // 1. Fetch every source; one that fails is reported and contributes nothing.
  const parsed: ParsedSource[] = [];
  const sourceOf = new Map<string, string>();
  const failures: string[] = [];
  for (const url of config.sources) {
    try {
      const source = await fetchSource(url, {
        ...config,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      parsed.push(source);
      result.skipped += source.skipped.length;
      for (const entry of source.entries)
        if (!sourceOf.has(entry.key)) sourceOf.set(entry.key, url);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (parsed.length === 0) {
    logger.warn(
      { failures },
      'catalog sync: no source could be read; keeping the last good catalog',
    );
    return finish('failed', failures.join('; '));
  }
  const incoming = mergeSources(parsed);

  // 2. Diff and apply under one lock, so two replicas never apply the same change twice.
  const lastOk = await db.catalogSyncRun.findFirst({
    where: { status: 'ok' },
    orderBy: { startedAt: 'desc' },
    select: { sources: true },
  });
  const sameSources =
    lastOk !== null &&
    JSON.stringify([...lastOk.sources].sort()) === JSON.stringify([...config.sources].sort());
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT 1 AS locked FROM pg_advisory_xact_lock($1)',
          CATALOG_SYNC_LOCK,
        );
        const rows = await tx.catalogModel.findMany();
        const stored = new Map(rows.map((r) => [r.key, r]));
        const current = new Map(catalog.models.map((e) => [e.key, e]));
        for (const row of rows) current.set(row.key, rowToEntry(row));
        const syncedKeys = new Set(rows.filter((r) => r.removedAt === null).map((r) => r.key));
        const diff = diffCatalog([...current.values()], incoming, syncedKeys);
        // Removals are only trusted when every source answered.
        const removed = failures.length === 0 ? diff.removed : [];
        // A changed source list (a mirror replacing the public list) legitimately changes the set.
        const shrink = sameSources ? shrinkError(syncedKeys.size, removed.length) : undefined;
        if (shrink) throw new Error(shrink);

        const source = (key: string) => sourceOf.get(key) ?? config.sources[0] ?? '';
        if (diff.added.length > 0) {
          await tx.catalogModel.createMany({
            data: diff.added.map((e) => ({
              key: e.key,
              ...entryData(e, e.pricing, source(e.key)),
            })),
            skipDuplicates: true,
          });
          result.added = diff.added.length;
        }
        // Metadata-only changes (and bundled entries seen for the first time) are applied as is.
        for (const entry of diff.metadataChanged) {
          const prev = current.get(entry.key);
          const data = entryData(entry, prev?.pricing ?? entry.pricing, source(entry.key));
          await tx.catalogModel.upsert({
            where: { key: entry.key },
            create: { key: entry.key, ...data },
            update: data,
          });
          result.updated++;
        }
        // Entries that came back after being missing.
        const returned = incoming.filter((e) => stored.get(e.key)?.removedAt);
        if (returned.length > 0)
          await tx.catalogModel.updateMany({
            where: { key: { in: returned.map((e) => e.key) } },
            data: { removedAt: null },
          });

        for (const change of diff.priceChanged) {
          const { key, before, after, factor } = change;
          // The entry row always exists, with the price still in force, so a proposal can be approved.
          const data = entryData(after, before.pricing, source(key));
          await tx.catalogModel.upsert({ where: { key }, create: { key, ...data }, update: data });
          const pending = await tx.catalogPriceProposal.findMany({
            where: { catalogKey: key, status: { in: ['pending', 'rejected'] } },
          });
          const automatic = config.mode === 'auto' && factor <= config.maxChangeFactor;
          if (automatic) {
            await tx.catalogModel.update({
              where: { key },
              data: { pricing: toJson(after.pricing) },
            });
            await repriceCatalogModels(tx, key, after.pricing);
            await tx.catalogPriceProposal.updateMany({
              where: { catalogKey: key, status: 'pending' },
              data: { status: 'superseded', decidedAt: new Date() },
            });
            result.repriced++;
            continue;
          }
          // Already proposed (or already rejected) with exactly this price: nothing new to ask.
          const same = pending.find((p) =>
            samePricing(p.proposedPricing as CatalogEntry['pricing'], after.pricing),
          );
          if (same) continue;
          await tx.catalogPriceProposal.updateMany({
            where: { catalogKey: key, status: 'pending' },
            data: { status: 'superseded', decidedAt: new Date() },
          });
          await tx.catalogPriceProposal.create({
            data: {
              id: prefixedId('cpp'),
              catalogKey: key,
              source: source(key),
              currentPricing: toJson(before.pricing),
              proposedPricing: toJson(after.pricing),
              changeFactor: Number.isFinite(factor) ? factor.toFixed(4) : null,
              reason: config.mode === 'auto' ? 'large_change' : 'manual_mode',
            },
          });
          result.proposed++;
        }
        // A source that went back to the price in force makes its pending proposal moot.
        const unchangedKeys = incoming
          .filter((e) => !diff.priceChanged.some((c) => c.key === e.key))
          .map((e) => e.key);
        if (unchangedKeys.length > 0)
          await tx.catalogPriceProposal.updateMany({
            where: { catalogKey: { in: unchangedKeys }, status: 'pending' },
            data: { status: 'superseded', decidedAt: new Date() },
          });

        if (removed.length > 0) {
          await tx.catalogModel.updateMany({
            where: { key: { in: removed }, removedAt: null },
            data: { removedAt: new Date() },
          });
          result.removed = removed.length;
        }
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error }, 'catalog sync rejected; keeping the last good catalog');
    return finish('failed', [message, ...failures].join('; '));
  }

  if (result.repriced > 0)
    await deps.requestRebuild?.().catch((error: unknown) => {
      logger.warn({ err: error }, 'catalog sync: snapshot rebuild request failed');
    });
  logger.info({ ...result, failures }, 'catalog sync done');
  return finish('ok', failures.length > 0 ? failures.join('; ') : undefined);
}
