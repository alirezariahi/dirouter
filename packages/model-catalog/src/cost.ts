/**
 * Cost calculation from canonical usage and model prices (card 6.2), with no floats at all.
 *
 * - Regular input = inputTokens − cacheRead − cacheWrite, priced at the input rate
 * - cache read/write at their own rates (if absent, the input rate)
 * - Regular output = outputTokens − reasoning, priced at the output rate; reasoning at its own rate or the output rate
 */
import type { CanonicalUsage, ModelPricing } from '@dirouter/contracts';
import { costForTokens, formatUsd, type UsdUnits } from '@dirouter/shared';

export interface CostBreakdown {
  input: UsdUnits;
  cacheRead: UsdUnits;
  cacheWrite: UsdUnits;
  output: UsdUnits;
  reasoning: UsdUnits;
  total: UsdUnits;
}

export function computeCost(usage: CanonicalUsage, pricing: ModelPricing): CostBreakdown {
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
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    total: input + cacheRead + cacheWrite + output + reasoning,
  };
}

export function computeCostUsd(usage: CanonicalUsage, pricing: ModelPricing): string {
  return formatUsd(computeCost(usage, pricing).total);
}
