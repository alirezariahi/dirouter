/**
 * Cost calculation from canonical usage and model prices (card 6.2), with no floats at all.
 *
 * - Regular input = inputTokens − cacheRead − cacheWrite, priced at the input rate
 * - cache read/write at their own rates (if absent, the input rate)
 * - Regular output = outputTokens − reasoning, priced at the output rate; reasoning at its own rate or the output rate
 * - Media (card 21.1): images × per-image price, characters at the per-million-characters price and
 *   audio or video seconds (to the millisecond) at the per-second price, and requests at the
 *   per-request price (card 30.6), added to any token cost
 * - Context tiers (card 27.5): a prompt longer than a tier's threshold is priced at that tier
 * - Realtime audio tokens (card 30.5): at the audio rates (the text rates when unset); cached audio
 *   at the cache read rate
 */
import type { CanonicalUsage, MediaUsage, ModelPricing } from '@dirouter/contracts';
import { costForTokens, formatUsd, parseUsd, type UsdUnits } from '@dirouter/shared';

export interface CostBreakdown {
  input: UsdUnits;
  cacheRead: UsdUnits;
  cacheWrite: UsdUnits;
  output: UsdUnits;
  reasoning: UsdUnits;
  media: UsdUnits;
  total: UsdUnits;
}

/** The audio token share of a realtime response (card 30.5). */
export function audioTokenCost(media: MediaUsage | undefined, pricing: ModelPricing): UsdUnits {
  if (!media) return 0n;
  const cached = Math.min(media.audioCachedTokens ?? 0, media.audioInputTokens ?? 0);
  const plain = (media.audioInputTokens ?? 0) - cached;
  const inputRate = pricing.audioInputPerMTok ?? pricing.inputPerMTok;
  return (
    costForTokens(plain, inputRate) +
    costForTokens(cached, pricing.cacheReadPerMTok ?? inputRate) +
    costForTokens(media.audioOutputTokens ?? 0, pricing.audioOutputPerMTok ?? pricing.outputPerMTok)
  );
}

export function mediaCost(media: MediaUsage | undefined, pricing: ModelPricing): UsdUnits {
  if (!media) return 0n;
  let total = audioTokenCost(media, pricing);
  if (media.images && pricing.perImageUsd)
    total += BigInt(media.images) * parseUsd(pricing.perImageUsd);
  if (media.characters && pricing.perMCharUsd)
    total += costForTokens(media.characters, pricing.perMCharUsd);
  if (media.seconds && pricing.perSecondUsd) {
    const ms = BigInt(Math.round(media.seconds * 1_000));
    total += (ms * parseUsd(pricing.perSecondUsd) + 500n) / 1_000n;
  }
  if (media.requests && pricing.perRequestUsd)
    total += BigInt(media.requests) * parseUsd(pricing.perRequestUsd);
  if (media.searches && pricing.perSearchUsd)
    total += BigInt(media.searches) * parseUsd(pricing.perSearchUsd);
  return total;
}

/**
 * Rates for this request (card 27.5): the highest context tier whose threshold the prompt exceeds
 * replaces the base token rates (unset tier rates keep the base rate); media prices never tier.
 */
export function effectivePricing(pricing: ModelPricing, inputTokens: number): ModelPricing {
  const tier = (pricing.tiers ?? [])
    .filter((t) => inputTokens > t.aboveInputTokens)
    .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)[0];
  if (!tier) return pricing;
  return {
    ...pricing,
    inputPerMTok: tier.inputPerMTok,
    outputPerMTok: tier.outputPerMTok,
    ...(tier.cacheReadPerMTok ? { cacheReadPerMTok: tier.cacheReadPerMTok } : {}),
    ...(tier.cacheWritePerMTok ? { cacheWritePerMTok: tier.cacheWritePerMTok } : {}),
  };
}

export function computeCost(
  usage: CanonicalUsage,
  basePricing: ModelPricing,
  media?: MediaUsage,
): CostBreakdown {
  const pricing = effectivePricing(basePricing, usage.inputTokens);
  const plainInput = Math.max(
    0,
    usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens,
  );
  const plainOutput = Math.max(0, usage.outputTokens - usage.reasoningTokens);
  const input = costForTokens(plainInput, pricing.inputPerMTok);
  const cacheRead = costForTokens(
    usage.cacheReadTokens,
    pricing.cacheReadPerMTok ?? pricing.inputPerMTok,
  );
  const cacheWrite = costForTokens(
    usage.cacheWriteTokens,
    pricing.cacheWritePerMTok ?? pricing.inputPerMTok,
  );
  const output = costForTokens(plainOutput, pricing.outputPerMTok);
  const reasoning = costForTokens(
    usage.reasoningTokens,
    pricing.reasoningPerMTok ?? pricing.outputPerMTok,
  );
  const mediaUnits = mediaCost(media, pricing);
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    media: mediaUnits,
    total: input + cacheRead + cacheWrite + output + reasoning + mediaUnits,
  };
}

export function computeCostUsd(
  usage: CanonicalUsage,
  pricing: ModelPricing,
  media?: MediaUsage,
): string {
  return formatUsd(computeCost(usage, pricing, media).total);
}

/**
 * A price at the batch rate (card 30.1): `units × (1 − batchDiscount)`, rounded half up. Without a
 * discount in the catalog the batch price is the normal price.
 */
export function batchPrice(
  units: UsdUnits,
  pricing: Pick<ModelPricing, 'batchDiscount'>,
): UsdUnits {
  if (!pricing.batchDiscount) return units;
  const one = parseUsd('1');
  const keep = one - parseUsd(pricing.batchDiscount);
  if (keep <= 0n) return 0n;
  return (units * keep + one / 2n) / one;
}
