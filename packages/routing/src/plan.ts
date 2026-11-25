/**
 * Route planning: one function shared by live traffic and the routing simulator, so both always
 * give the same answer for the same request (cards 32.1, 32.5 and 32.7).
 *
 * Stages, in order:
 *   1. resolve the requested model and each `models` fallback (card 5.1 resolver, unchanged)
 *   2. data policy: region, country, zero data retention, training use (card 32.5)
 *   3. provider preferences: only/ignore, max price, sort, order, allow fallbacks (card 32.1)
 *
 * A rules stage (conditional routing) runs before this and hands over the model it chose.
 */
import type { DataPolicy, ProviderPreferences, VirtualKeyConfig } from '@dirouter/contracts';

import { applyDataPolicy, type DataPolicyError, isDataPolicyEmpty } from './data-policy.js';
import { applyPreferences, type PreferenceError } from './preferences.js';
import {
  isRouteError,
  type ResolvedRoute,
  type ResolveOptions,
  type RouteError,
  type Router,
} from './router.js';

export interface PlanInput {
  key: VirtualKeyConfig;
  /** The requested model (suffixes already removed). */
  model: string;
  /** OpenRouter's `models` array: tried in order after the requested model. */
  fallbackModels?: readonly string[] | undefined;
  /** Effective provider preferences (administrator's and client's, merged). */
  preferences?: ProviderPreferences | undefined;
  /** Effective data policy (organization, project, key and request, strictest). */
  dataPolicy?: DataPolicy | undefined;
  resolve?: ResolveOptions;
}

export interface RoutePlan extends ResolvedRoute {
  /** The model names the candidates came from, in order. */
  models: string[];
  preferences?: ProviderPreferences;
  dataPolicy?: DataPolicy;
}

export type PlanError = RouteError | PreferenceError | DataPolicyError;

export function isPlanError(r: RoutePlan | PlanError): r is PlanError {
  return 'error' in r;
}

/** At most this many fallback models, like OpenRouter. */
export const MAX_FALLBACK_MODELS = 8;

export function planRoute(router: Router, input: PlanInput): RoutePlan | PlanError {
  const names = [
    ...new Set([input.model, ...(input.fallbackModels ?? []).slice(0, MAX_FALLBACK_MODELS)]),
  ];
  let primary: ResolvedRoute | undefined;
  let firstError: RouteError | undefined;
  const candidates: ResolvedRoute['candidates'] = [];
  const skipped: ResolvedRoute['skipped'] = [];
  const seen = new Set<string>();
  const models: string[] = [];
  for (const [index, name] of names.entries()) {
    const resolved = router.resolve(input.key, name, input.resolve);
    if (isRouteError(resolved)) {
      firstError ??= resolved;
      skipped.push(...resolved.skipped);
      // A fallback that does not exist or is not allowed is reported, never fatal.
      if (index > 0) skipped.push({ modelId: name, reason: `fallback_${resolved.error}` });
      continue;
    }
    primary ??= resolved;
    models.push(name);
    skipped.push(...resolved.skipped);
    for (const c of resolved.candidates) {
      const id = `${c.model.id}|${c.credential.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(c);
    }
  }
  if (!primary) return firstError ?? { error: 'model_not_found', skipped };
  let route: ResolvedRoute = { ...primary, requested: input.model, candidates, skipped };
  const dataPolicy = isDataPolicyEmpty(input.dataPolicy) ? undefined : input.dataPolicy;
  if (dataPolicy) {
    const allowed = applyDataPolicy(route, dataPolicy);
    if ('error' in allowed) return allowed;
    route = allowed;
  }
  if (input.preferences && Object.keys(input.preferences).length > 0) {
    const applied = applyPreferences(route, input.preferences, {
      stats: router.stats,
      estimatedInputTokens: input.resolve?.estimatedInputTokens,
      maxOutputTokens: input.resolve?.maxOutputTokens,
      priceMultiplier: input.key.priceMultiplier,
    });
    if ('error' in applied) return applied;
    route = applied;
  }
  return {
    ...route,
    models,
    ...(input.preferences && Object.keys(input.preferences).length > 0
      ? { preferences: input.preferences }
      : {}),
    ...(dataPolicy ? { dataPolicy } : {}),
  };
}
