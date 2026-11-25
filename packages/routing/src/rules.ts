/**
 * Conditional routing rules (card 32.2): the stage that runs before candidate selection.
 *
 * Rules of an organization are evaluated in priority order. A rule applies to the whole
 * organization, or only to one team or project (a team's own policy). The first matching `route`
 * or `reject` decides the request; matching `tag` rules add labels and evaluation goes on.
 * Conditions are compiled once per snapshot; a condition that fails to compile (an imported image,
 * say) is skipped and reported, never evaluated.
 */
import type { RoutingRuleConfig, VirtualKeyConfig } from '@dirouter/contracts';

import { compileExpression, type CompiledExpression, type RuleInput } from './rules-expr.js';

interface CompiledRule {
  rule: RoutingRuleConfig;
  condition: CompiledExpression;
}

export interface RuleDecision {
  /** Ids of every rule that matched, in order. */
  matched: string[];
  /** The rule whose `route` or `reject` decided the request. */
  decidedBy?: RoutingRuleConfig;
  /** `route` target. */
  target?: string;
  reject?: { message: string; status: 400 | 403 | 429 };
  tags: Record<string, string>;
}

const NO_BUDGET = { key: 0, project: 0, team: 0, max: 0 };

export class RulesEngine {
  readonly #byOrg = new Map<string, CompiledRule[]>();
  /** Rules that could not be compiled (id → problem), for logs and the dashboard. */
  readonly invalid = new Map<string, string>();

  constructor(rules: readonly RoutingRuleConfig[]) {
    const sorted = [...rules]
      .filter((r) => r.enabled)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    for (const rule of sorted) {
      let condition: CompiledExpression;
      try {
        condition = compileExpression(rule.condition);
      } catch (error) {
        this.invalid.set(rule.id, (error as Error).message);
        continue;
      }
      let list = this.#byOrg.get(rule.organizationId);
      if (!list) this.#byOrg.set(rule.organizationId, (list = []));
      list.push({ rule, condition });
    }
  }

  #applicable(key: VirtualKeyConfig): CompiledRule[] {
    const list = this.#byOrg.get(key.organizationId);
    if (!list) return [];
    return list.filter(
      ({ rule }) =>
        (rule.teamId === undefined || rule.teamId === key.teamId) &&
        (rule.projectId === undefined || rule.projectId === key.projectId),
    );
  }

  /** Whether the key's organization has any rule at all (the common case is none: no work). */
  has(key: VirtualKeyConfig): boolean {
    return this.#byOrg.has(key.organizationId);
  }

  /** Whether a rule for this key reads `budget.*`, so the caller must look the spend up first. */
  needsBudget(key: VirtualKeyConfig): boolean {
    return this.#applicable(key).some((r) => r.condition.usesBudget);
  }

  evaluate(
    key: VirtualKeyConfig,
    input: Omit<RuleInput, 'budget' | 'key'> & { budget?: RuleInput['budget'] },
  ): RuleDecision {
    const decision: RuleDecision = { matched: [], tags: {} };
    const rules = this.#applicable(key);
    if (rules.length === 0) return decision;
    const full: RuleInput = {
      request: input.request,
      key: {
        id: key.id,
        project: key.projectId,
        team: key.teamId ?? '',
        organization: key.organizationId,
      },
      budget: input.budget ?? NO_BUDGET,
    };
    for (const { rule, condition } of rules) {
      if (!condition.evaluate(full)) continue;
      decision.matched.push(rule.id);
      const action = rule.action;
      if (action.type === 'tag') {
        Object.assign(decision.tags, action.tags);
        continue;
      }
      decision.decidedBy = rule;
      if (action.type === 'route') decision.target = action.target;
      else
        decision.reject = {
          message: action.message ?? `Request rejected by routing rule '${rule.name}'`,
          status: action.status,
        };
      break;
    }
    return decision;
  }
}
