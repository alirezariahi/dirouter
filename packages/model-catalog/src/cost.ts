/**
 * Cost calculation from canonical usage and model prices (card 6.2), with no floats at all.
 *
 * - Regular input = inputTokens − cacheRead − cacheWrite, priced at the input rate
 * - cache read/write at their own rates (if absent, the input rate)
 * - Regular output = outputTokens − reasoning, priced at the output rate; reasoning at its own rate or the output rate
 * - Media (card 21.1): images × per-image price, characters at the per-million-characters price and
 *   audio seconds (to the millisecond) at the per-second price, added to any token cost
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

export function mediaCost(media: MediaUsage | undefined, pricing: ModelPricing): UsdUnits {
  if (!media) return 0n;
  let total = 0n;
  if (media.images && pricing.perImageUsd)
    total += BigInt(media.images) * parseUsd(pricing.perImageUsd);
  if (media.characters && pricing.perMCharUsd)
    total += costForTokens(media.characters, pricing.perMCharUsd);
  if (media.seconds && pricing.perSecondUsd) {
    const ms = BigInt(Math.round(media.seconds * 1_000));
    total += (ms * parseUsd(pricing.perSecondUsd) + 500n) / 1_000n;
  }
  return total;
}

export function computeCost(
  usage: CanonicalUsage,
  pricing: ModelPricing,
  media?: MediaUsage,
): CostBreakdown {
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
