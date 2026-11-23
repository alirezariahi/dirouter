/**
 * Sale price of a request (card 19.4), next to its cost.
 *
 * - token-priced model: cost × the model's sale multiplier × the customer group's multiplier
 * - fixed-price model (`sale.perRequestUsd`): that price × the group multiplier
 * - answer from DiRouter's own cache: the price above × `sale.cacheMultiplier` (default 0)
 *
 * Without sale settings every multiplier is 1, so the charge equals the cost. All arithmetic is
 * fixed-point (1 USD = 10^8 units), like the rest of the money code.
 */
import type { CanonicalUsage, ModelPricing, SalePrice } from '@dirouter/contracts';
import { computeCost } from '@dirouter/model-catalog';
import { formatUsd, parseUsd, type UsdUnits } from '@dirouter/shared';

const ONE = parseUsd('1');

/** units × multiplier, rounded half up. */
function scale(units: UsdUnits, multiplier: string | undefined): UsdUnits {
  if (multiplier === undefined) return units;
  const m = parseUsd(multiplier);
  if (m === ONE) return units;
  return (units * m + ONE / 2n) / ONE;
}

export interface PricedModel {
  pricing: ModelPricing;
  sale?: SalePrice | undefined;
}

export function chargeUnits(
  usage: CanonicalUsage,
  model: PricedModel,
  options: { groupMultiplier?: string | undefined; cacheHit?: boolean | undefined } = {},
): UsdUnits {
  const sale = model.sale;
  const list =
    sale?.perRequestUsd !== undefined
      ? parseUsd(sale.perRequestUsd)
      : scale(computeCost(usage, model.pricing).total, sale?.multiplier);
  const grouped = scale(list, options.groupMultiplier);
  return options.cacheHit ? scale(grouped, sale?.cacheMultiplier ?? '0') : grouped;
}

export function chargeUsd(
  usage: CanonicalUsage,
  model: PricedModel,
  options: { groupMultiplier?: string | undefined; cacheHit?: boolean | undefined } = {},
): string {
  return formatUsd(chargeUnits(usage, model, options));
}
