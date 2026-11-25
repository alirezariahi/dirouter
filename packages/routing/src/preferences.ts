/**
 * Provider preferences (card 32.1): `order`, `only`, `ignore`, `allowFallbacks`, `sort` and
 * `maxPrice` applied to a resolved candidate list. Pure functions; every removed candidate is
 * recorded with its reason so the simulator and the response explanation can show it.
 */
import type { ModelConfig, ProviderConfig, ProviderPreferences } from '@dirouter/contracts';

import type { Candidate, ResolvedRoute } from './router.js';
import type { RouterStats } from './stats.js';

export interface PreferenceContext {
  stats: RouterStats;
  estimatedInputTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** The key's customer group multiplier (card 19.4); prices compare what the customer pays. */
  priceMultiplier?: string | undefined;
}

export type PreferenceError = {
  error: 'no_provider_matches_preferences';
  skipped: ResolvedRoute['skipped'];
};

/** A provider is named by its slug, its type or its display name (case-insensitive). */
export function providerMatches(provider: ProviderConfig, name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return (
    provider.slug.toLowerCase() === wanted ||
    provider.type.toLowerCase() === wanted ||
    provider.name.toLowerCase() === wanted
  );
}

export interface UnitPrices {
  /** USD per million input tokens. */
  prompt: number;
  /** USD per million output tokens. */
  completion: number;
  request?: number;
  image?: number;
}

/** What the customer pays per unit for a model: list price × sale multiplier × group multiplier. */
export function unitPrices(model: ModelConfig, priceMultiplier?: string): UnitPrices {
  const group = priceMultiplier ? Number(priceMultiplier) : 1;
  const sale = model.sale?.multiplier ? Number(model.sale.multiplier) : 1;
  const m = group * sale;
  return {
    prompt: Number(model.pricing.inputPerMTok) * m,
    completion: Number(model.pricing.outputPerMTok) * m,
    ...(model.sale?.perRequestUsd !== undefined
      ? { request: Number(model.sale.perRequestUsd) * group }
      : {}),
    ...(model.pricing.perImageUsd !== undefined
      ? { image: Number(model.pricing.perImageUsd) * m }
      : {}),
  };
}

/** Estimated price of the request in USD on this model (input estimate + output cap). */
export function estimatedPriceUsd(
  model: ModelConfig,
  inputTokens: number,
  outputTokens: number,
  priceMultiplier?: string,
): number {
  const p = unitPrices(model, priceMultiplier);
  if (p.request !== undefined) return p.request;
  return (inputTokens * p.prompt + outputTokens * p.completion) / 1_000_000;
}

/** The first limit the model's price breaks, or undefined when it is within all of them. */
export function aboveMaxPrice(
  model: ModelConfig,
  max: NonNullable<ProviderPreferences['maxPrice']>,
  priceMultiplier?: string,
): string | undefined {
  const p = unitPrices(model, priceMultiplier);
  const tol = 1e-9;
  if (max.prompt !== undefined && p.prompt > max.prompt + tol) return 'prompt';
  if (max.completion !== undefined && p.completion > max.completion + tol) return 'completion';
  if (max.request !== undefined && p.request !== undefined && p.request > max.request + tol)
    return 'request';
  if (max.image !== undefined && p.image !== undefined && p.image > max.image + tol) return 'image';
  return undefined;
}

function stableSort<T>(items: T[], key: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, k: key(item) }))
    .sort((a, b) => (a.k === b.k ? a.index - b.index : a.k < b.k ? -1 : 1))
    .map((x) => x.item);
}

/** Sort key for `sort`; lower is better, unknown values last. */
export function sortKey(
  sort: NonNullable<ProviderPreferences['sort']>,
  candidate: Candidate,
  ctx: PreferenceContext,
): number {
  if (sort === 'price')
    return estimatedPriceUsd(
      candidate.model,
      ctx.estimatedInputTokens ?? 0,
      ctx.maxOutputTokens ?? 1_024,
      ctx.priceMultiplier,
    );
  if (sort === 'throughput') {
    const tps = ctx.stats.throughput(candidate.model.id);
    return tps === undefined ? Number.POSITIVE_INFINITY : -tps;
  }
  return ctx.stats.peakLatency(candidate.model.id) ?? Number.POSITIVE_INFINITY;
}

/**
 * Applies the preferences to the route's candidates, in this order: `only` and `ignore`,
 * `maxPrice`, `sort`, then `order` (which wins over `sort`) and `allowFallbacks`.
 */
export function applyPreferences(
  route: ResolvedRoute,
  prefs: ProviderPreferences,
  ctx: PreferenceContext,
): ResolvedRoute | PreferenceError {
  const skipped = [...route.skipped];
  const drop = (c: Candidate, reason: string) => {
    skipped.push({ modelId: c.model.id, credentialId: c.credential.id, reason });
  };
  let candidates = route.candidates.filter((c) => {
    if (prefs.only && !prefs.only.some((name) => providerMatches(c.provider, name))) {
      drop(c, 'provider_not_in_only');
      return false;
    }
    if (prefs.ignore?.some((name) => providerMatches(c.provider, name))) {
      drop(c, 'provider_ignored');
      return false;
    }
    if (prefs.maxPrice) {
      const over = aboveMaxPrice(c.model, prefs.maxPrice, ctx.priceMultiplier);
      if (over) {
        drop(c, `above_max_price_${over}`);
        return false;
      }
    }
    return true;
  });
  if (prefs.sort) {
    const sort = prefs.sort;
    candidates = stableSort(candidates, (c) => sortKey(sort, c, ctx));
  }
  if (prefs.order && prefs.order.length > 0) {
    const order = prefs.order;
    const rank = (c: Candidate) => {
      const at = order.findIndex((name) => providerMatches(c.provider, name));
      return at < 0 ? order.length : at;
    };
    candidates = stableSort(candidates, rank);
    if (prefs.allowFallbacks === false)
      candidates = candidates.filter((c) => {
        if (rank(c) < order.length) return true;
        drop(c, 'fallbacks_not_allowed');
        return false;
      });
  } else if (prefs.allowFallbacks === false && candidates[0]) {
    const first = candidates[0].provider.id;
    candidates = candidates.filter((c) => {
      if (c.provider.id === first) return true;
      drop(c, 'fallbacks_not_allowed');
      return false;
    });
  }
  if (candidates.length === 0) return { error: 'no_provider_matches_preferences', skipped };
  return { ...route, candidates, skipped };
}
