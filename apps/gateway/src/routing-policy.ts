/**
 * The organization's routing policies that run before candidate selection (sprint 5).
 *
 * Conditional rules (card 32.2) can send a request to another model, alias, combo or `auto*`
 * name, reject it, or tag it. The stage runs after authentication, guardrails and compression and
 * before automatic routing and the resolver, so everything downstream sees the rule's target as if
 * the client had asked for it (the key's allow-list was checked against what the client asked).
 */
import type { CanonicalRequest, PolicyTrace, VirtualKeyConfig } from '@dirouter/contracts';
import type { RuleDecision } from '@dirouter/routing';
import type { FastifyRequest } from 'fastify';

import type { BudgetUsage } from './budget-guard.js';
import type { LoadedConfig } from './config-store.js';

export interface RulesOutcome {
  decision: RuleDecision;
  trace: NonNullable<PolicyTrace['rules']>;
}

/** Runs the rules of the key's organization; undefined when it has none (the common case). */
export async function applyRoutingRules(
  config: LoadedConfig,
  key: VirtualKeyConfig,
  req: FastifyRequest,
  canonical: CanonicalRequest,
  estimatedInputTokens: number,
  /** Spend of the key's budgets; only asked when a rule reads `budget.*`. */
  budgetUsage: (() => Promise<BudgetUsage>) | undefined,
): Promise<RulesOutcome | undefined> {
  const engine = config.rules;
  if (!engine.has(key)) return undefined;
  // A name the key may not use is refused by the resolver as before; rules never widen access.
  if (key.allowedModels.length > 0 && !key.allowedModels.includes(canonical.model))
    return undefined;
  const budget = budgetUsage && engine.needsBudget(key) ? await budgetUsage() : undefined;
  const decision = engine.evaluate(key, {
    request: {
      model: canonical.model,
      api: canonical.inboundApi,
      stream: canonical.stream,
      headers: req.headers,
      metadata: canonical.metadata ?? {},
      estimated_tokens: estimatedInputTokens,
      max_output_tokens: canonical.maxOutputTokens ?? 0,
      user: canonical.user ?? '',
      has_tools: (canonical.tools?.length ?? 0) > 0,
      has_images: canonical.messages.some((m) => m.content.some((p) => p.type === 'image')),
    },
    ...(budget ? { budget } : {}),
  });
  if (decision.matched.length === 0) return { decision, trace: { matched: [] } };
  return {
    decision,
    trace: {
      matched: decision.matched,
      ...(decision.decidedBy ? { decidedBy: decision.decidedBy.id } : {}),
      ...(decision.target ? { target: decision.target } : {}),
      ...(Object.keys(decision.tags).length > 0 ? { tags: decision.tags } : {}),
    },
  };
}
