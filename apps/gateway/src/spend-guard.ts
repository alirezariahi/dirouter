/**
 * Admission of a request against every rate limit and budget that covers it (cards 6.1, 6.3,
 * 25.5 and 33.1), in one place for the chat path (proxy.ts) and the metered paths (metered.ts).
 *
 * Scopes:
 * - the key itself, its project and team (card 25.5), the whole organization and the member who
 *   created the key (card 33.1): an exhausted budget or a full rate window rejects the request;
 * - the end user the request names (card 33.2): its own limits and budgets, or else the
 *   organization's defaults for every end user (scope id `*`) on counters of its own; a blocked
 *   end user is refused with 403 before anything is counted;
 * - every tag the request carries and its cost center (card 33.4), within the organization;
 * - limits of the key on one model (card 33.3): an entry naming a candidate's model behaves like
 *   a model scope of that key; an entry naming the alias or combo the client asked for covers the
 *   whole request;
 * - models and providers of the organization (card 33.1): their budgets only take the matching
 *   candidates out of the route, so a combo falls back to its other targets, and only a route with
 *   no candidate left is rejected. Their rate limits count the target the request goes to first.
 *
 * Valkey round trips do not grow with the number of scopes: every budget is read by one Lua
 * script (BudgetGuard.check) and every rate limit is checked and applied by one atomic Lua script
 * (RateLimiter.acquire). Every scope name carries the organization, so two tenants never share a
 * counter. Outage behaviour is the guards' own: fail-open lets requests through, fail-closed
 * answers 429.
 */
import {
  type BudgetConfig,
  budgetPeriodLabel,
  type BudgetScope,
  type ConfigSnapshot,
  type RateLimitConfig,
  END_USER_DEFAULT,
  endUserCounterId,
  type LimitScopeKind,
  type ScopeLimitConfig,
  type VirtualKeyConfig,
} from '@dirouter/contracts';
import type { Candidate } from '@dirouter/routing';
import { DiRouterError, RateLimitError } from '@dirouter/shared';

import type { Attribution } from './attribution.js';
import type { BudgetCheck, BudgetGuard, BudgetTarget, ScopedBudget } from './budget-guard.js';
import { matchesTarget } from './budget-guard.js';
import type { LimitScope, RateLimiter } from './rate-limiter.js';

type ScopeIndex = Map<string, ScopeLimitConfig>;
const indexes = new WeakMap<ConfigSnapshot, ScopeIndex>();

/** `organization|scope|scopeId` → limits, built once per snapshot. */
function scopeIndex(snapshot: ConfigSnapshot): ScopeIndex {
  let index = indexes.get(snapshot);
  if (!index) {
    index = new Map();
    for (const l of snapshot.limits) index.set(`${l.organizationId}|${l.scope}|${l.scopeId}`, l);
    indexes.set(snapshot, index);
  }
  return index;
}

const lookup = (
  snapshot: ConfigSnapshot,
  organizationId: string,
  scope: LimitScopeKind,
  scopeId: string | null | undefined,
): ScopeLimitConfig | undefined =>
  scopeId ? scopeIndex(snapshot).get(`${organizationId}|${scope}|${scopeId}`) : undefined;

/** A limit as the guard uses it: a shared scope of the snapshot, or one model of a key. */
interface Scope {
  organizationId: string;
  scope: BudgetScope;
  scopeId: string;
  rateLimit?: RateLimitConfig | undefined;
  budgets: BudgetConfig[];
  blocked?: boolean | undefined;
  /** Counter id of each budget, when one budget counts many subjects apart. */
  counterOf?: (budgetId: string) => string;
  /** Rate-limit counter name, when it is not derived from the scope. */
  name?: string;
}

/** What the request is for, beyond the key. */
interface RequestContext {
  attribution: Attribution;
  /** The name the client asked for (model, alias or combo). */
  requested?: string | undefined;
  candidates: readonly Candidate[];
}

type ModelLimit = NonNullable<VirtualKeyConfig['modelLimits']>[number];
const keyModelScope = (key: VirtualKeyConfig, entry: ModelLimit): Scope => ({
  organizationId: key.organizationId,
  scope: 'key_model',
  scopeId: `${key.id}|${entry.model}`,
  rateLimit: entry.rateLimit,
  budgets: entry.budgets,
  name: `kmodel:${key.id}:${entry.model}`,
});

/** Rate-limit counter name of a scope; the organization is part of every shared scope. */
function limitName(l: Scope): string {
  if (l.name) return l.name;
  switch (l.scope) {
    // team and project ids are unique across organizations, and these names predate card 33.1.
    case 'team':
    case 'project':
      return `${l.scope}:${l.scopeId}`;
    case 'organization':
      return `org:${l.organizationId}`;
    default:
      return `${l.scope}:${l.organizationId}:${l.scopeId}`;
  }
}

/**
 * The end user's limits: its own entry, field by field over the organization's defaults. Default
 * budgets keep their ids but count each end user on a counter of its own.
 */
function endUserScope(
  snapshot: ConfigSnapshot,
  organizationId: string,
  endUser: string | undefined,
): (ScopeLimitConfig & { counterOf?: (budgetId: string) => string }) | undefined {
  if (!endUser) return undefined;
  const own = lookup(snapshot, organizationId, 'end_user', endUser);
  const defaults = lookup(snapshot, organizationId, 'end_user', END_USER_DEFAULT);
  if (!own && !defaults) return undefined;
  const ownBudgets = own?.budgets ?? [];
  const rateLimit = own?.rateLimit ?? defaults?.rateLimit;
  return {
    organizationId,
    scope: 'end_user',
    scopeId: endUser,
    ...(rateLimit ? { rateLimit } : {}),
    budgets: ownBudgets.length > 0 ? ownBudgets : (defaults?.budgets ?? []),
    ...(own?.blocked ? { blocked: true } : {}),
    ...(ownBudgets.length > 0
      ? {}
      : { counterOf: (budgetId: string) => endUserCounterId(budgetId, endUser) }),
  };
}

/**
 * The scopes that reject a request: organization, team, project, member, end user, and a key's
 * limits on the alias or combo name the client asked for.
 */
function requestScopes(
  snapshot: ConfigSnapshot,
  key: VirtualKeyConfig,
  ctx: RequestContext,
): Scope[] {
  const org = key.organizationId;
  return [
    lookup(snapshot, org, 'organization', org),
    lookup(snapshot, org, 'team', key.teamId),
    lookup(snapshot, org, 'project', key.projectId),
    lookup(snapshot, org, 'user', key.userId),
    endUserScope(snapshot, org, ctx.attribution.endUser),
    ...(ctx.attribution.tags ?? []).map((tag) => lookup(snapshot, org, 'tag', tag)),
    lookup(snapshot, org, 'cost_center', ctx.attribution.costCenter),
    ...(key.modelLimits ?? [])
      .filter(
        (entry) =>
          entry.model === ctx.requested &&
          !ctx.candidates.some((c) => c.model.slug === entry.model),
      )
      .map((entry) => keyModelScope(key, entry)),
  ].filter((l) => l !== undefined);
}

/** Model and provider scopes of one candidate, with the target they cover. */
function candidateScopes(
  snapshot: ConfigSnapshot,
  key: VirtualKeyConfig,
  c: Candidate,
): { limit: Scope; target: BudgetTarget }[] {
  const org = key.organizationId;
  const out: { limit: Scope; target: BudgetTarget }[] = [];
  // The key's own limits on this candidate's model (card 33.3).
  for (const entry of key.modelLimits ?? [])
    if (entry.model === c.model.slug)
      out.push({ limit: keyModelScope(key, entry), target: { modelId: c.model.id } });
  const model = lookup(snapshot, org, 'model', c.model.id);
  if (model) out.push({ limit: model, target: { modelId: c.model.id } });
  const provider = lookup(snapshot, org, 'provider', c.provider.id);
  if (provider) out.push({ limit: provider, target: { providerId: c.provider.id } });
  return out;
}

const scoped = (l: Scope, target?: BudgetTarget): ScopedBudget[] =>
  l.budgets.map((budget) => ({
    budget,
    scope: l.scope,
    scopeId: l.scopeId,
    organizationId: l.organizationId,
    ...(l.counterOf ? { counterId: l.counterOf(budget.id) } : {}),
    ...(target ? { target } : {}),
  }));

/** Every budget that covers a request to these candidates. */
export function budgetScopes(
  config: { snapshot: ConfigSnapshot },
  key: VirtualKeyConfig,
  candidates: readonly Candidate[] = [],
  attribution: Attribution = {},
  requested?: string,
): ScopedBudget[] {
  const out: ScopedBudget[] = key.budgets.map((budget) => ({
    budget,
    scope: 'key',
    scopeId: key.id,
    organizationId: key.organizationId,
  }));
  for (const l of requestScopes(config.snapshot, key, { attribution, requested, candidates }))
    out.push(...scoped(l));
  const seen = new Set<string>();
  for (const c of candidates)
    for (const { limit, target } of candidateScopes(config.snapshot, key, c)) {
      const id = `${limit.scope}|${limit.scopeId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(...scoped(limit, target));
    }
  return out;
}

/** Every rate limit that covers a request sent first to `first`. */
export function limitScopes(
  config: { snapshot: ConfigSnapshot },
  key: VirtualKeyConfig,
  first?: Candidate,
  attribution: Attribution = {},
  requested?: string,
  candidates: readonly Candidate[] = first ? [first] : [],
): LimitScope[] {
  const scopes: LimitScope[] = [];
  if (key.rateLimit) scopes.push({ name: `key:${key.id}`, limit: key.rateLimit });
  const shared = [
    ...requestScopes(config.snapshot, key, { attribution, requested, candidates }),
    ...(first ? candidateScopes(config.snapshot, key, first).map((s) => s.limit) : []),
  ];
  for (const l of shared) if (l.rateLimit) scopes.push({ name: limitName(l), limit: l.rateLimit });
  return scopes;
}

const SCOPE_LABEL: Record<string, string> = {
  org: 'organization',
  end_user: 'end user',
  cost_center: 'cost center',
  kmodel: 'this key on this model',
};

/** What a finished request used, for settling rate windows and counting budgets. */
export interface Spent {
  tokens: number;
  /** Input and output apart, for input and output TPM (card 33.3); `tokens` counts as input when absent. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd: string;
  /** The candidate that answered; undefined for cache hits and failures. */
  candidate?: Candidate | undefined;
}

export type Admission =
  | {
      ok: true;
      /** The route's candidates without those whose model or provider budget is used up. */
      candidates: Candidate[];
      headers: Record<string, string>;
      /** Settles the rate windows and counts the spend in every budget; call once. */
      finish: (spent: Spent) => void;
      /** Releases the rate windows of a request that never reached a provider. */
      cancel: () => void;
    }
  | {
      ok: false;
      error: DiRouterError;
      headers: Record<string, string>;
      metric: { guard: 'rate_limit' | 'budget' | 'end_user'; reason: string };
    };

export interface AdmitInput {
  config: { snapshot: ConfigSnapshot };
  key: VirtualKeyConfig;
  candidates: readonly Candidate[];
  /** The name the client asked for, for error messages. */
  requested: string;
  /**
   * Tokens reserved in the TPM windows: the input estimate and the output cap apart (input and
   * output TPM, card 33.3), or one total that counts as input.
   */
  estimatedTokens: number | { input: number; output: number };
  requestId: string;
  /** The end user the request names (card 33.2). */
  attribution?: Attribution;
}

const retryAfter = (resetAt: Date) =>
  String(Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)));

export async function admitRequest(
  deps: { budgets?: BudgetGuard | undefined; limiter?: RateLimiter | undefined },
  input: AdmitInput,
): Promise<Admission> {
  const { config, key } = input;
  const attribution = input.attribution ?? {};
  if (endUserScope(config.snapshot, key.organizationId, attribution.endUser)?.blocked)
    return {
      ok: false,
      headers: {},
      error: new DiRouterError('end_user_blocked', {
        message: 'This end user is blocked by the organization',
      }),
      metric: { guard: 'end_user', reason: 'blocked' },
    };
  const budgets = budgetScopes(config, key, input.candidates, attribution, input.requested);
  const check: BudgetCheck = deps.budgets ? await deps.budgets.check(budgets) : { ok: true };
  if (!check.ok) {
    const what = check.kind === 'usd' ? `USD ${check.limit}` : `${check.limit} tokens`;
    return {
      ok: false,
      headers: { 'retry-after': retryAfter(check.resetAt) },
      error: new DiRouterError('budget_exceeded', {
        message: check.unavailable
          ? 'Budget check unavailable (fail-closed), retry shortly'
          : `${budgetPeriodLabel(check.period)} ${check.scope.replace('_', ' ')} budget exceeded (${what})`,
      }),
      metric: { guard: 'budget', reason: check.unavailable ? 'unavailable' : check.kind },
    };
  }

  let candidates = [...input.candidates];
  if (check.exhausted) {
    const spent = check.exhausted;
    candidates = candidates.filter(
      (c) =>
        !spent.some(({ budget }) =>
          budget.target
            ? matchesTarget(budget.target, {
                modelId: c.model.id,
                providerId: c.provider.id,
                credentialId: c.credential.id,
              })
            : false,
        ),
    );
    if (candidates.length === 0) {
      const first = spent.reduce((a, b) => (b.resetAt < a.resetAt ? b : a));
      return {
        ok: false,
        headers: { 'retry-after': retryAfter(first.resetAt) },
        error: new DiRouterError('budget_exceeded', {
          message: `${budgetPeriodLabel(first.budget.budget.period)} ${first.budget.scope.replace('_', ' ')} budget exceeded for every target of '${input.requested}'`,
        }),
        metric: { guard: 'budget', reason: 'target' },
      };
    }
  }

  const limiter = deps.limiter
    ? await deps.limiter.acquire(
        limitScopes(config, key, candidates[0], attribution, input.requested, input.candidates),
        input.estimatedTokens,
        input.requestId,
      )
    : undefined;
  if (limiter && !limiter.ok) {
    const prefix = limiter.scope.split(':')[0] ?? 'key';
    return {
      ok: false,
      headers: limiter.headers,
      error: new RateLimitError({
        message: limiter.unavailable
          ? 'Rate limiter unavailable (fail-closed), retry shortly'
          : `Rate limit exceeded for ${SCOPE_LABEL[prefix] ?? prefix} (${limiter.kind})`,
        retryAfterMs: limiter.retryAfterMs,
      }),
      metric: { guard: 'rate_limit', reason: limiter.unavailable ? 'unavailable' : limiter.kind },
    };
  }

  let done = false;
  return {
    ok: true,
    candidates,
    headers: limiter?.headers ?? {},
    finish: (spent) => {
      if (done) return;
      done = true;
      limiter?.settle(
        spent.inputTokens !== undefined || spent.outputTokens !== undefined
          ? { input: spent.inputTokens ?? 0, output: spent.outputTokens ?? 0 }
          : spent.tokens,
      );
      limiter?.release();
      const served = spent.candidate;
      deps.budgets?.record(
        budgets,
        spent.costUsd,
        spent.tokens,
        served
          ? {
              modelId: served.model.id,
              providerId: served.provider.id,
              credentialId: served.credential.id,
            }
          : undefined,
      );
    },
    cancel: () => {
      if (done) return;
      done = true;
      limiter?.settle(0);
      limiter?.release();
    },
  };
}
