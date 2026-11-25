/**
 * Model, alias, and combo catalog (card 3.8).
 *
 * - Default pricing comes from `@dirouter/model-catalog/catalog` (a versioned JSON file). A model created with
 *   a catalogKey is updated to the new catalog price by `sync-catalog`, without a migration.
 * - Names (model slug, alias, and combo) share one namespace so name resolution in the gateway stays unique.
 */
import {
  DEFAULT_FALLBACK_ON,
  type ModelCapabilities,
  type ModelPricing,
} from '@dirouter/contracts';
import { modelPriceColumns, Prisma } from '@dirouter/db';
import { catalog } from '@dirouter/model-catalog/catalog';
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { CatalogService } from './catalog.service.js';

export interface ModelInput {
  providerId: string;
  upstreamModel: string;
  slug?: string | undefined;
  displayName?: string | null | undefined;
  enabled?: boolean | undefined;
  contextWindow?: number | null | undefined;
  maxOutputTokens?: number | null | undefined;
  pricing?: Partial<ModelPricing> | undefined;
  capabilities?: Partial<ModelCapabilities> | undefined;
  catalogKey?: string | null | undefined;
  /** Drop a manual price and follow the catalog entry again (card 27.5). */
  followCatalog?: boolean | undefined;
  isPublic?: boolean | undefined;
  sale?:
    | {
        multiplier?: string | undefined;
        perRequestUsd?: string | null | undefined;
        cacheMultiplier?: string | undefined;
      }
    | undefined;
}
export interface ComboInput {
  slug: string;
  strategy?:
    | 'priority'
    | 'weighted'
    | 'round-robin'
    | 'latency'
    | 'cost'
    | 'least-used'
    | 'headroom'
    | undefined;
  targets: { modelId: string; order?: number | undefined; weight?: number | undefined }[];
  fallbackOn?: string[] | undefined;
  retryMaxAttempts?: number | undefined;
  timeouts?: Record<string, number | undefined> | null | undefined;
  sticky?: boolean | undefined;
  hedging?: { enabled?: boolean; afterMs?: number; maxParallel?: number } | null | undefined;
  isPublic?: boolean | undefined;
}

/** Sale settings to columns; absent fields are left unchanged. */
function saleData(sale: ModelInput['sale']) {
  if (!sale) return {};
  return {
    ...(sale.multiplier !== undefined ? { saleMultiplier: sale.multiplier } : {}),
    ...(sale.perRequestUsd !== undefined ? { salePerRequestUsd: sale.perRequestUsd } : {}),
    ...(sale.cacheMultiplier !== undefined ? { saleCacheMultiplier: sale.cacheMultiplier } : {}),
  };
}

const STRATEGY_TO_DB = {
  priority: 'PRIORITY',
  weighted: 'WEIGHTED',
  'round-robin': 'ROUND_ROBIN',
  latency: 'LATENCY',
  cost: 'COST',
  'least-used': 'LEAST_USED',
  headroom: 'HEADROOM',
} as const;
const STRATEGY_FROM_DB = {
  PRIORITY: 'priority',
  WEIGHTED: 'weighted',
  ROUND_ROBIN: 'round-robin',
  LATENCY: 'latency',
  COST: 'cost',
  LEAST_USED: 'least-used',
  HEADROOM: 'headroom',
} as const;
const notFound = (what = 'Resource') =>
  new DiRouterError('not_found', { message: `${what} not found` });
const invalid = (message: string) => new DiRouterError('validation_failed', { message });
const dec = (d: Prisma.Decimal | null) =>
  d === null ? undefined : d.toFixed(8).replace(/\.?0+$/, '') || '0';

@Injectable()
export class ModelsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CatalogService) private readonly catalogs: CatalogService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  /** The effective catalog: bundled entries overlaid with synced ones (card 27.5). */
  async catalog() {
    const [version, models] = await Promise.all([this.catalogs.version(), this.catalogs.entries()]);
    return { version, currency: catalog.currency, models };
  }

  // ───── Model ─────
  modelView(m: Awaited<ReturnType<ModelsService['loadModel']>>) {
    return {
      id: m.id,
      slug: m.slug,
      providerId: m.providerId,
      upstreamModel: m.upstreamModel,
      displayName: m.displayName,
      enabled: m.enabled,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      pricing: {
        inputPerMTok: dec(m.inputPrice) ?? '0',
        outputPerMTok: dec(m.outputPrice) ?? '0',
        ...(m.cacheReadPrice ? { cacheReadPerMTok: dec(m.cacheReadPrice) } : {}),
        ...(m.cacheWritePrice ? { cacheWritePerMTok: dec(m.cacheWritePrice) } : {}),
        ...(m.reasoningPrice ? { reasoningPerMTok: dec(m.reasoningPrice) } : {}),
        ...(m.imagePrice ? { perImageUsd: dec(m.imagePrice) } : {}),
        ...(m.charPrice ? { perMCharUsd: dec(m.charPrice) } : {}),
        ...(m.secondPrice ? { perSecondUsd: dec(m.secondPrice) } : {}),
        ...(m.audioInputPrice ? { audioInputPerMTok: dec(m.audioInputPrice) } : {}),
        ...(m.audioOutputPrice ? { audioOutputPerMTok: dec(m.audioOutputPrice) } : {}),
        ...(Array.isArray(m.pricingTiers) && m.pricingTiers.length > 0
          ? { tiers: m.pricingTiers as unknown as NonNullable<ModelPricing['tiers']> }
          : {}),
        ...(m.batchDiscount ? { batchDiscount: dec(m.batchDiscount) } : {}),
      },
      capabilities: m.capabilities,
      catalogKey: m.catalogKey,
      priceOverride: m.priceOverride,
      deprecationDate: m.deprecationDate ? m.deprecationDate.toISOString().slice(0, 10) : null,
      isPublic: m.isPublic,
      sale: {
        multiplier: dec(m.saleMultiplier) ?? '1',
        perRequestUsd: dec(m.salePerRequestUsd) ?? null,
        cacheMultiplier: dec(m.saleCacheMultiplier) ?? '0',
      },
    };
  }

  async loadModel(ctx: OrgContext, id: string) {
    const m = await this.db.model.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
    });
    if (!m) throw notFound('Model');
    return m;
  }

  async models(ctx: OrgContext) {
    const rows = await this.db.model.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      orderBy: { slug: 'asc' },
    });
    return rows.map((m) => this.modelView(m));
  }

  /** Names are unique across the organization: models, aliases, and combos do not collide. */
  async #nameFree(
    ctx: OrgContext,
    slug: string,
    except?: { kind: 'model' | 'alias' | 'combo'; id: string },
  ) {
    const org = ctx.organizationId;
    const [m, a, c] = await Promise.all([
      this.db.model.findFirst({
        where: { organizationId: org, slug, deletedAt: null },
        select: { id: true },
      }),
      this.db.modelAlias.findFirst({ where: { organizationId: org, slug }, select: { id: true } }),
      this.db.combo.findFirst({
        where: { organizationId: org, slug, deletedAt: null },
        select: { id: true },
      }),
    ]);
    const taken = [
      m && !(except?.kind === 'model' && except.id === m.id),
      a && !(except?.kind === 'alias' && except.id === a.id),
      c && !(except?.kind === 'combo' && except.id === c.id),
    ].some(Boolean);
    if (taken)
      throw new DiRouterError('conflict', {
        message: `Name '${slug}' is already used by a model, alias or combo`,
      });
  }

  async #fromCatalog(catalogKey: string | null | undefined) {
    if (!catalogKey) return undefined;
    const entry = await this.catalogs.find(catalogKey);
    if (!entry) throw invalid(`unknown catalog key ${catalogKey}`);
    return entry;
  }

  async createModel(ctx: OrgContext, input: ModelInput) {
    const provider = await this.db.provider.findFirst({
      where: { id: input.providerId, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true, slug: true },
    });
    if (!provider) throw notFound('Provider');
    const entry = await this.#fromCatalog(input.catalogKey);
    const pricing = { ...entry?.pricing, ...input.pricing };
    // Explicit prices on a catalog model are the organization's own: syncs leave them alone.
    const priceOverride =
      entry !== undefined &&
      Object.values(input.pricing ?? {}).some((v: unknown) => v !== undefined);
    // A hand-priced model does not inherit the catalog's context tiers, only its own.
    const tiers = input.pricing?.tiers ?? (priceOverride ? undefined : entry?.pricing.tiers);
    if (!pricing.inputPerMTok || !pricing.outputPerMTok)
      throw invalid(
        'pricing.inputPerMTok and pricing.outputPerMTok are required (or a catalogKey)',
      );
    const slug = input.slug ?? `${provider.slug}/${input.upstreamModel}`;
    await this.#nameFree(ctx, slug);
    const id = prefixedId('mdl');
    await this.db.model.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        providerId: provider.id,
        slug,
        upstreamModel: input.upstreamModel,
        displayName: input.displayName ?? null,
        enabled: input.enabled ?? true,
        contextWindow: input.contextWindow ?? entry?.contextWindow ?? null,
        maxOutputTokens: input.maxOutputTokens ?? entry?.maxOutputTokens ?? null,
        inputPrice: pricing.inputPerMTok,
        outputPrice: pricing.outputPerMTok,
        cacheReadPrice: pricing.cacheReadPerMTok ?? null,
        cacheWritePrice: pricing.cacheWritePerMTok ?? null,
        reasoningPrice: pricing.reasoningPerMTok ?? null,
        imagePrice: pricing.perImageUsd ?? null,
        charPrice: pricing.perMCharUsd ?? null,
        secondPrice: pricing.perSecondUsd ?? null,
        audioInputPrice: pricing.audioInputPerMTok ?? null,
        audioOutputPrice: pricing.audioOutputPerMTok ?? null,
        ...(tiers && tiers.length > 0 ? { pricingTiers: tiers } : {}),
        batchDiscount: pricing.batchDiscount ?? null,
        deprecationDate: entry?.deprecationDate ? new Date(entry.deprecationDate) : null,
        priceOverride,
        capabilities: { ...entry?.capabilities, ...input.capabilities },
        catalogKey: input.catalogKey ?? null,
        isPublic: input.isPublic ?? false,
        ...saleData(input.sale),
      },
    });
    await this.#audit(ctx, 'model.created', 'model', id, { slug });
    return this.modelView(await this.loadModel(ctx, id));
  }

  async updateModel(
    ctx: OrgContext,
    id: string,
    input: Partial<Omit<ModelInput, 'providerId' | 'upstreamModel'>>,
  ) {
    const m = await this.loadModel(ctx, id);
    if (input.slug && input.slug !== m.slug)
      await this.#nameFree(ctx, input.slug, { kind: 'model', id });
    const p = input.pricing ?? {};
    const manualPrice = Object.values(p).some((v: unknown) => v !== undefined);
    const catalogKey = input.catalogKey !== undefined ? input.catalogKey : m.catalogKey;
    // Back to the catalog price: the organization's own price is dropped.
    const follow =
      input.followCatalog === true && !manualPrice
        ? await this.#fromCatalog(catalogKey)
        : undefined;
    if (input.followCatalog === true && !follow)
      throw invalid('followCatalog needs a catalogKey and no explicit pricing');
    await this.db.model.update({
      where: { id },
      data: {
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(p.inputPerMTok ? { inputPrice: p.inputPerMTok } : {}),
        ...(p.outputPerMTok ? { outputPrice: p.outputPerMTok } : {}),
        ...(p.cacheReadPerMTok ? { cacheReadPrice: p.cacheReadPerMTok } : {}),
        ...(p.cacheWritePerMTok ? { cacheWritePrice: p.cacheWritePerMTok } : {}),
        ...(p.reasoningPerMTok ? { reasoningPrice: p.reasoningPerMTok } : {}),
        ...(p.perImageUsd ? { imagePrice: p.perImageUsd } : {}),
        ...(p.perMCharUsd ? { charPrice: p.perMCharUsd } : {}),
        ...(p.perSecondUsd ? { secondPrice: p.perSecondUsd } : {}),
        ...(p.audioInputPerMTok ? { audioInputPrice: p.audioInputPerMTok } : {}),
        ...(p.audioOutputPerMTok ? { audioOutputPrice: p.audioOutputPerMTok } : {}),
        ...(p.tiers
          ? {
              pricingTiers:
                p.tiers.length > 0 ? (p.tiers as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            }
          : {}),
        ...(p.batchDiscount ? { batchDiscount: p.batchDiscount } : {}),
        ...(input.capabilities
          ? {
              capabilities: {
                ...(m.capabilities as object),
                ...input.capabilities,
              },
            }
          : {}),
        ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
        ...saleData(input.sale),
        ...(input.catalogKey !== undefined ? { catalogKey: input.catalogKey } : {}),
        // A manual price no longer follows the catalog (card 27.5): the model keeps its catalog key
        // (deprecation dates and the follow-catalog switch still work), but syncs and approved
        // price changes leave the price alone.
        ...(manualPrice && catalogKey ? { priceOverride: true } : {}),
        ...(follow
          ? {
              ...modelPriceColumns(follow.pricing),
              priceOverride: false,
              deprecationDate: follow.deprecationDate ? new Date(follow.deprecationDate) : null,
            }
          : {}),
      },
    });
    await this.#audit(ctx, 'model.updated', 'model', id, input);
    return this.modelView(await this.loadModel(ctx, id));
  }

  async deleteModel(ctx: OrgContext, id: string) {
    await this.loadModel(ctx, id);
    const used = await this.db.comboTarget.count({
      where: { modelId: id, combo: { deletedAt: null } },
    });
    const aliased = await this.db.modelAlias.count({ where: { modelId: id } });
    if (used + aliased > 0)
      throw new DiRouterError('conflict', { message: 'Model is used by a combo or alias' });
    await this.db.model.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false, slug: `deleted-${id}` },
    });
    await this.#audit(ctx, 'model.deleted', 'model', id);
  }

  /**
   * Syncs the price and context of this organization's catalog models with the effective catalog
   * (bundled plus synced entries). Models priced by hand are left alone.
   */
  async syncCatalog(ctx: OrgContext) {
    const rows = await this.db.model.findMany({
      where: {
        organizationId: ctx.organizationId,
        deletedAt: null,
        catalogKey: { not: null },
        priceOverride: false,
      },
    });
    const entries = new Map((await this.catalogs.entries()).map((e) => [e.key, e]));
    let updated = 0;
    for (const m of rows) {
      const entry = entries.get(m.catalogKey ?? '');
      if (!entry) continue;
      const before = this.modelView(m);
      const deprecationDate = entry.deprecationDate ?? null;
      const changed =
        JSON.stringify(normalizePricing(before.pricing)) !==
          JSON.stringify(normalizePricing(entry.pricing)) ||
        (entry.contextWindow ?? null) !== m.contextWindow ||
        deprecationDate !== before.deprecationDate;
      if (!changed) continue;
      await this.db.model.update({
        where: { id: m.id },
        data: {
          ...modelPriceColumns(entry.pricing),
          contextWindow: entry.contextWindow ?? m.contextWindow,
          deprecationDate: deprecationDate ? new Date(deprecationDate) : null,
        },
      });
      updated++;
    }
    const version = await this.catalogs.version();
    if (updated > 0) await this.#audit(ctx, 'catalog.synced', 'catalog', version, { updated });
    return { catalogVersion: version, updated };
  }

  // ───── alias ─────
  async aliases(ctx: OrgContext) {
    const rows = await this.db.modelAlias.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: { slug: 'asc' },
    });
    return rows.map((a) => ({
      id: a.id,
      slug: a.slug,
      target: a.comboId
        ? { kind: 'combo' as const, comboId: a.comboId }
        : { kind: 'model' as const, modelId: a.modelId ?? '' },
    }));
  }

  async #checkTarget(
    ctx: OrgContext,
    target: { modelId?: string | undefined; comboId?: string | undefined },
  ) {
    if (Boolean(target.modelId) === Boolean(target.comboId))
      throw invalid('exactly one of modelId or comboId');
    if (target.modelId) await this.loadModel(ctx, target.modelId);
    if (target.comboId) await this.loadCombo(ctx, target.comboId);
  }

  async createAlias(
    ctx: OrgContext,
    input: { slug: string; modelId?: string | undefined; comboId?: string | undefined },
  ) {
    await this.#checkTarget(ctx, input);
    await this.#nameFree(ctx, input.slug);
    const id = prefixedId('als');
    await this.db.modelAlias.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        slug: input.slug,
        modelId: input.modelId ?? null,
        comboId: input.comboId ?? null,
      },
    });
    await this.#audit(ctx, 'alias.created', 'alias', id, input);
    return (await this.aliases(ctx)).find((a) => a.id === id);
  }

  async updateAlias(
    ctx: OrgContext,
    id: string,
    input: {
      slug?: string | undefined;
      modelId?: string | undefined;
      comboId?: string | undefined;
    },
  ) {
    const a = await this.db.modelAlias.findFirst({
      where: { id, organizationId: ctx.organizationId },
    });
    if (!a) throw notFound('Alias');
    if (input.modelId !== undefined || input.comboId !== undefined)
      await this.#checkTarget(ctx, input);
    if (input.slug && input.slug !== a.slug)
      await this.#nameFree(ctx, input.slug, { kind: 'alias', id });
    await this.db.modelAlias.update({
      where: { id },
      data: {
        ...(input.slug ? { slug: input.slug } : {}),
        ...(input.modelId !== undefined || input.comboId !== undefined
          ? { modelId: input.modelId ?? null, comboId: input.comboId ?? null }
          : {}),
      },
    });
    await this.#audit(ctx, 'alias.updated', 'alias', id, input);
    return (await this.aliases(ctx)).find((x) => x.id === id);
  }

  async deleteAlias(ctx: OrgContext, id: string) {
    const r = await this.db.modelAlias.deleteMany({
      where: { id, organizationId: ctx.organizationId },
    });
    if (r.count === 0) throw notFound('Alias');
    await this.#audit(ctx, 'alias.deleted', 'alias', id);
  }

  // ───── combo ─────
  async loadCombo(ctx: OrgContext, id: string) {
    const c = await this.db.combo.findFirst({
      where: { id, organizationId: ctx.organizationId, deletedAt: null },
      include: { targets: { orderBy: { order: 'asc' } } },
    });
    if (!c) throw notFound('Combo');
    return c;
  }

  comboView(c: Awaited<ReturnType<ModelsService['loadCombo']>>) {
    return {
      id: c.id,
      slug: c.slug,
      strategy: STRATEGY_FROM_DB[c.strategy],
      targets: c.targets.map((t) => ({ modelId: t.modelId, order: t.order, weight: t.weight })),
      fallbackOn: c.fallbackOn.length > 0 ? c.fallbackOn : DEFAULT_FALLBACK_ON,
      retryMaxAttempts: c.retryMaxAttempts,
      timeouts: c.timeouts ?? null,
      sticky: c.sticky,
      hedging: c.hedging ?? null,
      isPublic: c.isPublic,
    };
  }

  async combos(ctx: OrgContext) {
    const rows = await this.db.combo.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null },
      include: { targets: { orderBy: { order: 'asc' } } },
      orderBy: { slug: 'asc' },
    });
    return rows.map((c) => this.comboView(c));
  }

  /** A duplicate target, a nonexistent model, or another organization's model is rejected. */
  async #checkTargets(ctx: OrgContext, targets: ComboInput['targets']) {
    if (targets.length === 0) throw invalid('a combo needs at least one target');
    const ids = targets.map((t) => t.modelId);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw invalid(`duplicate target ${dup}`);
    const found = await this.db.model.findMany({
      where: { id: { in: ids }, organizationId: ctx.organizationId, deletedAt: null },
      select: { id: true },
    });
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) throw invalid(`unknown model ${missing.join(', ')}`);
  }

  async createCombo(ctx: OrgContext, input: ComboInput) {
    await this.#checkTargets(ctx, input.targets);
    await this.#nameFree(ctx, input.slug);
    const id = prefixedId('cmb');
    await this.db.combo.create({
      data: {
        id,
        organizationId: ctx.organizationId,
        slug: input.slug,
        strategy: STRATEGY_TO_DB[input.strategy ?? 'priority'],
        fallbackOn: input.fallbackOn ?? [],
        retryMaxAttempts: input.retryMaxAttempts ?? 2,
        sticky: input.sticky ?? false,
        isPublic: input.isPublic ?? false,
        ...(input.hedging ? { hedging: input.hedging } : {}),
        ...(input.timeouts ? { timeouts: input.timeouts } : {}),
        targets: {
          create: input.targets.map((t, i) => ({
            id: prefixedId('ct'),
            modelId: t.modelId,
            order: t.order ?? i,
            weight: t.weight ?? 1,
          })),
        },
      },
    });
    await this.#audit(ctx, 'combo.created', 'combo', id, {
      slug: input.slug,
      targets: input.targets.length,
    });
    return this.comboView(await this.loadCombo(ctx, id));
  }

  async updateCombo(ctx: OrgContext, id: string, input: Partial<ComboInput>) {
    const c = await this.loadCombo(ctx, id);
    if (input.targets) await this.#checkTargets(ctx, input.targets);
    if (input.slug && input.slug !== c.slug)
      await this.#nameFree(ctx, input.slug, { kind: 'combo', id });
    await this.db.$transaction(async (tx) => {
      await tx.combo.update({
        where: { id },
        data: {
          ...(input.slug ? { slug: input.slug } : {}),
          ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
          ...(input.strategy ? { strategy: STRATEGY_TO_DB[input.strategy] } : {}),
          ...(input.fallbackOn ? { fallbackOn: input.fallbackOn } : {}),
          ...(input.retryMaxAttempts !== undefined
            ? { retryMaxAttempts: input.retryMaxAttempts }
            : {}),
          ...(input.timeouts !== undefined
            ? {
                timeouts:
                  input.timeouts === null
                    ? Prisma.DbNull
                    : (input.timeouts as Prisma.InputJsonObject),
              }
            : {}),
          ...(input.sticky !== undefined ? { sticky: input.sticky } : {}),
          ...(input.hedging !== undefined
            ? {
                hedging:
                  input.hedging === null
                    ? Prisma.DbNull
                    : (input.hedging as Prisma.InputJsonObject),
              }
            : {}),
        },
      });
      if (input.targets) {
        await tx.comboTarget.deleteMany({ where: { comboId: id } });
        await tx.comboTarget.createMany({
          data: input.targets.map((t, i) => ({
            id: prefixedId('ct'),
            comboId: id,
            modelId: t.modelId,
            order: t.order ?? i,
            weight: t.weight ?? 1,
          })),
        });
      }
    });
    await this.#audit(ctx, 'combo.updated', 'combo', id, {
      ...input,
      targets: input.targets?.length,
    });
    return this.comboView(await this.loadCombo(ctx, id));
  }

  async deleteCombo(ctx: OrgContext, id: string) {
    await this.loadCombo(ctx, id);
    if ((await this.db.modelAlias.count({ where: { comboId: id } })) > 0)
      throw new DiRouterError('conflict', { message: 'Combo is used by an alias' });
    await this.db.combo.update({
      where: { id },
      data: { deletedAt: new Date(), slug: `deleted-${id}` },
    });
    await this.#audit(ctx, 'combo.deleted', 'combo', id);
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

function normalizePricing(p: ModelPricing) {
  const n = (v: string | undefined) => (v === undefined ? undefined : dec(new Prisma.Decimal(v)));
  return {
    inputPerMTok: n(p.inputPerMTok),
    outputPerMTok: n(p.outputPerMTok),
    ...(p.cacheReadPerMTok ? { cacheReadPerMTok: n(p.cacheReadPerMTok) } : {}),
    ...(p.cacheWritePerMTok ? { cacheWritePerMTok: n(p.cacheWritePerMTok) } : {}),
    ...(p.reasoningPerMTok ? { reasoningPerMTok: n(p.reasoningPerMTok) } : {}),
    ...(p.perImageUsd ? { perImageUsd: n(p.perImageUsd) } : {}),
    ...(p.perMCharUsd ? { perMCharUsd: n(p.perMCharUsd) } : {}),
    ...(p.perSecondUsd ? { perSecondUsd: n(p.perSecondUsd) } : {}),
    ...(p.audioInputPerMTok ? { audioInputPerMTok: n(p.audioInputPerMTok) } : {}),
    ...(p.audioOutputPerMTok ? { audioOutputPerMTok: n(p.audioOutputPerMTok) } : {}),
    ...(p.tiers && p.tiers.length > 0
      ? {
          tiers: [...p.tiers]
            .sort((a, b) => a.aboveInputTokens - b.aboveInputTokens)
            .map((t) => ({
              aboveInputTokens: t.aboveInputTokens,
              inputPerMTok: n(t.inputPerMTok),
              outputPerMTok: n(t.outputPerMTok),
              ...(t.cacheReadPerMTok ? { cacheReadPerMTok: n(t.cacheReadPerMTok) } : {}),
              ...(t.cacheWritePerMTok ? { cacheWritePerMTok: n(t.cacheWritePerMTok) } : {}),
            })),
        }
      : {}),
    ...(p.batchDiscount ? { batchDiscount: n(p.batchDiscount) } : {}),
  };
}
