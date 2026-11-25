/**
 * Catalog price application shared by the worker (automatic mode) and control-api (an admin
 * approving a proposal), card 27.5. A catalog price reaches request costs only through the
 * organization models that point at the catalog key: those rows are repriced here, except the
 * ones an organization priced by hand (`price_override`).
 */
import { Prisma, type PrismaClient } from '../generated/client/index.js';

/** ModelPricing as stored in catalog_models.pricing and proposals (decimal strings). */
export interface CatalogPricing {
  inputPerMTok: string;
  outputPerMTok: string;
  cacheReadPerMTok?: string | undefined;
  cacheWritePerMTok?: string | undefined;
  reasoningPerMTok?: string | undefined;
  perImageUsd?: string | undefined;
  perMCharUsd?: string | undefined;
  perSecondUsd?: string | undefined;
  perRequestUsd?: string | undefined;
  perSearchUsd?: string | undefined;
  audioInputPerMTok?: string | undefined;
  audioOutputPerMTok?: string | undefined;
  tiers?: Record<string, unknown>[] | undefined;
  batchDiscount?: string | undefined;
  /** Service tier prices (card 31.5). */
  serviceTiers?: Record<string, unknown> | undefined;
}

type Tx = Pick<PrismaClient, 'model' | 'catalogModel' | 'catalogPriceProposal'>;

/** Model columns for a catalog price. */
export function modelPriceColumns(pricing: CatalogPricing) {
  return {
    inputPrice: pricing.inputPerMTok,
    outputPrice: pricing.outputPerMTok,
    cacheReadPrice: pricing.cacheReadPerMTok ?? null,
    cacheWritePrice: pricing.cacheWritePerMTok ?? null,
    reasoningPrice: pricing.reasoningPerMTok ?? null,
    imagePrice: pricing.perImageUsd ?? null,
    charPrice: pricing.perMCharUsd ?? null,
    secondPrice: pricing.perSecondUsd ?? null,
    requestPrice: pricing.perRequestUsd ?? null,
    searchPrice: pricing.perSearchUsd ?? null,
    audioInputPrice: pricing.audioInputPerMTok ?? null,
    audioOutputPrice: pricing.audioOutputPerMTok ?? null,
    pricingTiers:
      pricing.tiers && pricing.tiers.length > 0
        ? (pricing.tiers as Prisma.InputJsonValue)
        : Prisma.DbNull,
    batchDiscount: pricing.batchDiscount ?? null,
    serviceTierPrices:
      pricing.serviceTiers && Object.keys(pricing.serviceTiers).length > 0
        ? (pricing.serviceTiers as Prisma.InputJsonValue)
        : Prisma.DbNull,
  };
}

/** Reprices every organization model on `catalogKey` that follows the catalog; returns the count. */
export async function repriceCatalogModels(
  tx: Tx,
  catalogKey: string,
  pricing: CatalogPricing,
): Promise<number> {
  const result = await tx.model.updateMany({
    where: { catalogKey, priceOverride: false, deletedAt: null },
    data: modelPriceColumns(pricing),
  });
  return result.count;
}

/**
 * Puts a pending proposal's price into force: the catalog entry, then the organization models.
 * Returns undefined when the proposal is not pending (already decided or superseded).
 *
 * The proposal is claimed first with a conditional update (`status = 'pending'`), so of two
 * concurrent decisions (two admins, or an admin and a sync superseding it) exactly one proceeds;
 * a plain read-then-write would let both reprice under READ COMMITTED.
 */
export async function approveCatalogProposal(
  db: Pick<PrismaClient, '$transaction'>,
  proposalId: string,
  decidedById: string | null,
): Promise<{ catalogKey: string; appliedModels: number } | undefined> {
  return db.$transaction(async (tx) => {
    const claimed = await tx.catalogPriceProposal.updateMany({
      where: { id: proposalId, status: 'pending' },
      data: { status: 'approved', decidedById, decidedAt: new Date() },
    });
    if (claimed.count !== 1) return undefined;
    const proposal = await tx.catalogPriceProposal.findUniqueOrThrow({ where: { id: proposalId } });
    const pricing = proposal.proposedPricing as unknown as CatalogPricing;
    await tx.catalogModel.update({
      where: { key: proposal.catalogKey },
      data: { pricing: pricing as unknown as Prisma.InputJsonValue },
    });
    const appliedModels = await repriceCatalogModels(tx, proposal.catalogKey, pricing);
    await tx.catalogPriceProposal.update({
      where: { id: proposalId },
      data: { appliedModels },
    });
    return { catalogKey: proposal.catalogKey, appliedModels };
  });
}
