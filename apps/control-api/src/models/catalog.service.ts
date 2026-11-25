/**
 * The effective model catalog and the admin side of catalog sync (card 27.5).
 *
 * The catalog bundled with the release is the baseline; entries the worker synced from external
 * price sources (catalog_models) overlay it, so a new model in the source is offered here without
 * a release. Price changes the worker held back are proposals: an operator of the platform
 * organization approves (the price goes into force for every organization model that follows the
 * catalog) or rejects them. When the sources are unreachable nothing changes here: the catalog is
 * whatever was last synced successfully.
 */
import { QUEUES } from '@dirouter/contracts';
import { approveCatalogProposal, type Prisma } from '@dirouter/db';
import { type CatalogEntry, catalog } from '@dirouter/model-catalog/catalog';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

export interface EffectiveCatalogEntry extends CatalogEntry {
  /** Where the entry comes from: the bundled catalog or an external source (its URL). */
  source: string;
  /** The sources stopped listing this entry (it stays usable). */
  removedFromSource?: true;
}

export interface CatalogSyncSettingsInput {
  enabled?: boolean | undefined;
  sources?: string[] | undefined;
  mode?: 'manual' | 'auto' | undefined;
  maxChangeFactor?: number | undefined;
}

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);

function fromRow(row: {
  key: string;
  provider: string;
  upstreamModel: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: unknown;
  capabilities: unknown;
  deprecationDate: Date | null;
  mode: string | null;
  source: string;
  removedAt: Date | null;
}): EffectiveCatalogEntry {
  const deprecationDate = dateOnly(row.deprecationDate);
  return {
    key: row.key,
    provider: row.provider,
    upstreamModel: row.upstreamModel,
    ...(row.contextWindow ? { contextWindow: row.contextWindow } : {}),
    ...(row.maxOutputTokens ? { maxOutputTokens: row.maxOutputTokens } : {}),
    pricing: row.pricing as CatalogEntry['pricing'],
    capabilities: row.capabilities as CatalogEntry['capabilities'],
    ...(deprecationDate ? { deprecationDate } : {}),
    ...(row.mode ? { mode: row.mode } : {}),
    source: row.source,
    ...(row.removedAt ? { removedFromSource: true as const } : {}),
  };
}

@Injectable()
export class CatalogService implements OnModuleDestroy {
  #queue: Queue | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async onModuleDestroy() {
    await this.#queue?.close().catch(() => undefined);
  }

  /** Bundled catalog overlaid with synced entries (a synced key wins). */
  async entries(): Promise<EffectiveCatalogEntry[]> {
    const out = new Map<string, EffectiveCatalogEntry>(
      catalog.models.map((e) => [e.key, { ...e, source: 'bundled' }]),
    );
    const rows = await this.db.catalogModel.findMany({ orderBy: { key: 'asc' } });
    for (const row of rows) out.set(row.key, fromRow(row));
    return [...out.values()];
  }

  async find(key: string): Promise<EffectiveCatalogEntry | undefined> {
    const row = await this.db.catalogModel.findUnique({ where: { key } });
    if (row) return fromRow(row);
    const bundled = catalog.models.find((e) => e.key === key);
    return bundled ? { ...bundled, source: 'bundled' } : undefined;
  }

  /** Version label: the bundled version plus the time of the last successful sync. */
  async version(): Promise<string> {
    const last = await this.db.catalogSyncRun.findFirst({
      where: { status: 'ok' },
      orderBy: { startedAt: 'desc' },
      select: { finishedAt: true },
    });
    return last?.finishedAt
      ? `${catalog.version}+sync.${last.finishedAt.toISOString()}`
      : catalog.version;
  }

  // ───── admin (platform organization) ─────

  async status() {
    const [row, runs, pending] = await Promise.all([
      this.db.catalogSyncSetting.findUnique({ where: { id: 'global' } }),
      this.db.catalogSyncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 20 }),
      this.db.catalogPriceProposal.count({ where: { status: 'pending' } }),
    ]);
    return {
      /** Stored settings; a field that is absent uses the worker's CATALOG_SYNC_* default. */
      settings: (row?.settings ?? {}) as CatalogSyncSettingsInput,
      pendingProposals: pending,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        sources: r.sources,
        mode: r.mode,
        added: r.added,
        updated: r.updated,
        repriced: r.repriced,
        proposed: r.proposed,
        removed: r.removed,
        skipped: r.skipped,
        error: r.error,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  async updateSettings(ctx: OrgContext, input: CatalogSyncSettingsInput) {
    const row = await this.db.catalogSyncSetting.findUnique({ where: { id: 'global' } });
    const merged: Record<string, unknown> = { ...((row?.settings ?? {}) as object) };
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      // An empty source list means "use the environment default".
      if (k === 'sources' && Array.isArray(v) && v.length === 0) delete merged.sources;
      else merged[k] = v;
    }
    await this.db.catalogSyncSetting.upsert({
      where: { id: 'global' },
      create: { id: 'global', settings: merged as Prisma.InputJsonObject, updatedBy: ctx.userId },
      update: {
        settings: merged as Prisma.InputJsonObject,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      },
    });
    await this.#audit(ctx, 'catalog.sync_settings_updated', 'catalog', 'global', merged);
    return (await this.status()).settings;
  }

  /** Queues a one-off sync on the worker's maintenance queue. */
  async runNow(ctx: OrgContext) {
    this.#queue ??= new Queue(QUEUES.maintenance, {
      connection: this.valkey.client.duplicate({ enableOfflineQueue: true }),
    });
    const job = await this.#queue.add(
      'catalog-sync',
      {},
      { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
    );
    await this.#audit(ctx, 'catalog.sync_requested', 'catalog', 'global');
    return { queued: true, jobId: job.id ?? null };
  }

  async proposals(status?: 'pending' | 'approved' | 'rejected' | 'superseded') {
    const rows = await this.db.catalogPriceProposal.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((p) => ({
      id: p.id,
      catalogKey: p.catalogKey,
      source: p.source,
      currentPricing: p.currentPricing,
      proposedPricing: p.proposedPricing,
      changeFactor: p.changeFactor?.toString() ?? null,
      reason: p.reason,
      status: p.status,
      decidedById: p.decidedById,
      decidedAt: p.decidedAt?.toISOString() ?? null,
      appliedModels: p.appliedModels,
      createdAt: p.createdAt.toISOString(),
    }));
  }

  async approve(ctx: OrgContext, id: string) {
    const result = await approveCatalogProposal(this.db, id, ctx.userId);
    if (!result) throw this.#notPending(id);
    await this.#audit(ctx, 'catalog.price_approved', 'catalog_proposal', id, result);
    return { id, status: 'approved' as const, ...result };
  }

  async reject(ctx: OrgContext, id: string) {
    const updated = await this.db.catalogPriceProposal.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'rejected', decidedById: ctx.userId, decidedAt: new Date() },
    });
    if (updated.count === 0) throw this.#notPending(id);
    await this.#audit(ctx, 'catalog.price_rejected', 'catalog_proposal', id);
    return { id, status: 'rejected' as const };
  }

  #notPending(id: string) {
    return new DiRouterError('not_found', { message: `No pending price proposal ${id}` });
  }

  async #audit(
    ctx: OrgContext,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action,
        targetType,
        targetId,
        ...(diff ? { diff: JSON.parse(JSON.stringify(diff)) as Prisma.InputJsonObject } : {}),
      },
    });
  }
}
