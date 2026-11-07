/**
 * محاسبهٔ هزینه از usage canonical و قیمت مدل (کارت ۶.۲)، بدون هیچ float.
 *
 * - ورودی عادی = inputTokens − cacheRead − cacheWrite با قیمت input
 * - cache read/write با قیمت خودشان (اگر نباشد، قیمت input)
 * - خروجی عادی = outputTokens − reasoning با قیمت output؛ reasoning با قیمت خودش یا output
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
