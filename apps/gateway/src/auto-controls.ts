/**
 * Controls of automatic routing on the request path (card 32.8): the organization's and the key's
 * cost tier and model sets narrow what `auto*` may choose, and the resolved candidates are held to
 * the same policy so a combo's fallback cannot bring an excluded model back.
 */
import type { ModelConfig, VirtualKeyConfig } from '@dirouter/contracts';
import {
  autoExclusion,
  type Classification,
  chooseReasoningEffort,
  DEFAULT_COST_TIERS,
  type EffectiveAutoPolicy,
  effectiveAutoPolicy,
  type ResolvedRoute,
} from '@dirouter/routing';

import type { LoadedConfig } from './config-store.js';

export interface AutoControls {
  policy: EffectiveAutoPolicy | undefined;
  /** The models of a name the policy lets `auto` pick; undefined when none is left. */
  permitted(models: ModelConfig[] | undefined): ModelConfig[] | undefined;
  /** What the policy imposed, for the decision's reasons. */
  reasons(): string[];
  /** Drops resolved candidates the policy excludes; returns the problem when none is left. */
  restrict(route: ResolvedRoute): string | undefined;
  /** The effort to ask for, when the client sent none and the first candidate can reason. */
  effort(
    classification: Pick<Classification, 'taskType' | 'size'>,
    route: ResolvedRoute,
    requested: string | undefined,
  ): 'minimal' | 'low' | 'medium' | 'high' | undefined;
}

export function autoControls(config: LoadedConfig, key: VirtualKeyConfig): AutoControls {
  const policy = effectiveAutoPolicy(config.snapshot.autoPolicies, key);
  const tiers = config.snapshot.settings.autoRouting?.costTiers ?? DEFAULT_COST_TIERS;
  const excluded = (m: ModelConfig) => (policy ? autoExclusion(m, policy, tiers) : undefined);
  return {
    policy,
    permitted(models) {
      if (!models || !policy) return models;
      const ok = models.filter((m) => excluded(m) === undefined);
      return ok.length > 0 ? ok : undefined;
    },
    reasons() {
      if (!policy) return [];
      const out: string[] = [];
      if (policy.costTier)
        out.push(
          policy.costTier === 'high'
            ? 'cost tier high: any price'
            : `cost tier ${policy.costTier}: up to $${
                policy.costTier === 'low' ? tiers.lowMaxPerMTok : tiers.mediumMaxPerMTok
              } per million tokens`,
        );
      for (const list of policy.allowed) out.push(`allowed models: ${list.join(', ')}`);
      if (policy.denied.length > 0) out.push(`denied models: ${policy.denied.join(', ')}`);
      if (policy.locked) out.push('organization policy locked by an administrator');
      return out;
    },
    restrict(route) {
      if (!policy) return undefined;
      const kept = route.candidates.filter((c) => {
        const why = excluded(c.model);
        if (why) route.skipped.push({ modelId: c.model.id, reason: 'auto_policy' });
        return why === undefined;
      });
      route.candidates.splice(0, route.candidates.length, ...kept);
      return kept.length === 0
        ? 'no model the automatic routing policy allows can serve this request'
        : undefined;
    },
    effort(classification, route, requested) {
      if (requested !== undefined || policy?.reasoningEffort === 'off') return undefined;
      if (route.candidates[0]?.model.capabilities.reasoning !== true) return undefined;
      return chooseReasoningEffort(classification, policy?.costTier);
    },
  };
}
