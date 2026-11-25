/**
 * Controls of automatic routing (card 32.8): a cost tier and allowed and denied model sets for an
 * organization and for a key, with an administrator's lock, and the reasoning effort `auto` picks.
 *
 * The policy is a filter over concrete models, applied twice: to the names `auto*` chooses between
 * (a name whose models are all filtered out is not a choice) and to the resolved candidates (a
 * combo's fallback cannot slip an expensive or excluded model back in). So with tier `low` no
 * request reaches a model priced above the `low` ceiling, and a model outside the allowed set is
 * never selected.
 */
import type {
  AutoCostTier,
  AutoRoutingPolicyConfig,
  GatewaySettings,
  ModelConfig,
  VirtualKeyConfig,
} from '@dirouter/contracts';

import type { Classification } from './classifier.js';

const TIER_ORDER: Record<AutoCostTier, number> = { low: 0, medium: 1, high: 2 };
export const DEFAULT_COST_TIERS = { lowMaxPerMTok: '1', mediumMaxPerMTok: '10' } as const;

export interface EffectiveAutoPolicy {
  costTier?: AutoCostTier;
  /** Every list must allow a model (organization and key, when the organization is locked). */
  allowed: string[][];
  denied: string[];
  reasoningEffort: 'auto' | 'off';
  /** The organization's policy is locked by an administrator. */
  locked: boolean;
}

/** Price per million tokens with three input tokens per output token. */
export function blendedPricePerMTok(model: Pick<ModelConfig, 'pricing'>): number {
  return (Number(model.pricing.inputPerMTok) * 3 + Number(model.pricing.outputPerMTok)) / 4;
}

export function costTierOf(
  model: Pick<ModelConfig, 'pricing'>,
  tiers: NonNullable<GatewaySettings['autoRouting']>['costTiers'] = DEFAULT_COST_TIERS,
): AutoCostTier {
  const price = blendedPricePerMTok(model);
  if (price <= Number(tiers.lowMaxPerMTok)) return 'low';
  if (price <= Number(tiers.mediumMaxPerMTok)) return 'medium';
  return 'high';
}

/** `openai/*` style globs; `*` matches any run of characters, everything else literally. */
export function matchesModel(patterns: readonly string[], slug: string): boolean {
  return patterns.some((p) => {
    if (!p.includes('*')) return p === slug;
    const parts = p.split('*');
    let at = 0;
    for (const [i, part] of parts.entries()) {
      if (i === 0) {
        if (!slug.startsWith(part)) return false;
        at = part.length;
        continue;
      }
      if (i === parts.length - 1) return part === '' || slug.slice(at).endsWith(part);
      const found = slug.indexOf(part, at);
      if (found < 0) return false;
      at = found + part.length;
    }
    return true;
  });
}

/**
 * The policy that applies to a key. Without a lock the key's own settings replace the
 * organization's (denied models always add up); with a lock the key can only narrow it.
 */
export function effectiveAutoPolicy(
  policies: readonly AutoRoutingPolicyConfig[],
  key: Pick<VirtualKeyConfig, 'id' | 'organizationId'>,
): EffectiveAutoPolicy | undefined {
  let org: AutoRoutingPolicyConfig | undefined;
  let own: AutoRoutingPolicyConfig | undefined;
  for (const p of policies) {
    if (p.organizationId !== key.organizationId) continue;
    if (p.scope === 'organization' && p.scopeId === key.organizationId) org = p;
    else if (p.scope === 'key' && p.scopeId === key.id) own = p;
  }
  if (!org && !own) return undefined;
  const locked = org?.locked === true;
  const denied = [...(org?.deniedModels ?? []), ...(own?.deniedModels ?? [])];
  const lists = (p: AutoRoutingPolicyConfig | undefined) =>
    p && p.allowedModels.length > 0 ? [p.allowedModels] : [];
  let costTier: AutoCostTier | undefined;
  let allowed: string[][];
  let reasoningEffort: 'auto' | 'off';
  if (locked) {
    const tiers = [org?.costTier, own?.costTier].filter((t): t is AutoCostTier => t !== undefined);
    costTier = tiers.sort((a, b) => TIER_ORDER[a] - TIER_ORDER[b])[0];
    allowed = [...lists(org), ...lists(own)];
    reasoningEffort = org?.reasoningEffort === 'off' ? 'off' : (own?.reasoningEffort ?? 'auto');
  } else {
    costTier = own?.costTier ?? org?.costTier;
    allowed = lists(own).length > 0 ? lists(own) : lists(org);
    reasoningEffort = own?.reasoningEffort ?? org?.reasoningEffort ?? 'auto';
  }
  return { ...(costTier ? { costTier } : {}), allowed, denied, reasoningEffort, locked };
}

/** Why a model may not be picked, or undefined when it may. */
export function autoExclusion(
  model: Pick<ModelConfig, 'slug' | 'pricing'>,
  policy: EffectiveAutoPolicy,
  tiers?: NonNullable<GatewaySettings['autoRouting']>['costTiers'],
): string | undefined {
  if (matchesModel(policy.denied, model.slug)) return `${model.slug} is denied`;
  if (policy.allowed.some((list) => !matchesModel(list, model.slug)))
    return `${model.slug} is not in the allowed set`;
  if (policy.costTier) {
    const tier = costTierOf(model, tiers);
    if (TIER_ORDER[tier] > TIER_ORDER[policy.costTier])
      return `${model.slug} is above the ${policy.costTier} cost tier`;
  }
  return undefined;
}

/**
 * The reasoning effort automatic routing asks for when the client sent none and the model can
 * reason: more for reasoning and coding work, the least for chat and summaries, never more than the
 * cost tier allows (`low` keeps it low).
 */
export function chooseReasoningEffort(
  classification: Pick<Classification, 'taskType' | 'size'>,
  costTier: AutoCostTier | undefined,
): 'minimal' | 'low' | 'medium' | 'high' {
  const wanted =
    classification.taskType === 'reasoning'
      ? 'high'
      : classification.taskType === 'coding'
        ? classification.size === 'large'
          ? 'high'
          : 'medium'
        : classification.taskType === 'summarization'
          ? 'low'
          : 'minimal';
  const cap = costTier === 'low' ? 'low' : costTier === 'medium' ? 'medium' : 'high';
  const order = ['minimal', 'low', 'medium', 'high'] as const;
  return order[Math.min(order.indexOf(wanted), order.indexOf(cap))] ?? 'minimal';
}
