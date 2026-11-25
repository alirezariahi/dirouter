/**
 * Per-request provider preferences (card 32.1) and the routing policies an administrator sets on
 * an organization, a project or a key.
 *
 * The request form follows OpenRouter's `provider` object (snake_case, unknown fields ignored), so
 * a client written for OpenRouter works unchanged; the gateway turns it into the camelCase
 * `ProviderPreferences` used everywhere else.
 */
import { z } from 'zod';

export const ProviderSort = z.enum(['price', 'throughput', 'latency']);
export type ProviderSort = z.infer<typeof ProviderSort>;

/** Highest acceptable price, in USD per million tokens (prompt, completion) or per unit. */
export const MaxPrice = z.object({
  prompt: z.number().nonnegative().optional(),
  completion: z.number().nonnegative().optional(),
  /** Per request (fixed-price models). */
  request: z.number().nonnegative().optional(),
  /** Per generated image. */
  image: z.number().nonnegative().optional(),
});
export type MaxPrice = z.infer<typeof MaxPrice>;

const ProviderNames = z.array(z.string().min(1).max(100)).max(50);

export const ProviderPreferences = z.object({
  /** Providers to try first, in this order (slug, type or name, case-insensitive). */
  order: ProviderNames.optional(),
  /** Only these providers. */
  only: ProviderNames.optional(),
  /** Never these providers. */
  ignore: ProviderNames.optional(),
  /** `false`: no provider outside `order` (or, without `order`, only the first one). */
  allowFallbacks: z.boolean().optional(),
  sort: ProviderSort.optional(),
  maxPrice: MaxPrice.optional(),
});
export type ProviderPreferences = z.infer<typeof ProviderPreferences>;

/** Accepts numbers and numeric strings (OpenRouter clients send both). */
const Price = z.union([z.number(), z.string().regex(/^\d+(\.\d+)?$/)]).transform(Number);

/** OpenRouter's `provider` request object; fields DiRouter does not use are accepted and ignored. */
export const ProviderRequestObject = z.looseObject({
  order: ProviderNames.nullish(),
  only: ProviderNames.nullish(),
  ignore: ProviderNames.nullish(),
  allow_fallbacks: z.boolean().nullish(),
  sort: z.union([ProviderSort, z.looseObject({ by: ProviderSort })]).nullish(),
  max_price: z
    .looseObject({
      prompt: Price.nullish(),
      completion: Price.nullish(),
      request: Price.nullish(),
      image: Price.nullish(),
    })
    .nullish(),
});
export type ProviderRequestObject = z.infer<typeof ProviderRequestObject>;

/** The request form → `ProviderPreferences` (only the fields that were set). */
export function preferencesFromRequest(raw: ProviderRequestObject): ProviderPreferences {
  const maxPrice: MaxPrice = {};
  for (const field of ['prompt', 'completion', 'request', 'image'] as const) {
    const value = raw.max_price?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) maxPrice[field] = value;
  }
  const sort = typeof raw.sort === 'string' ? raw.sort : raw.sort?.by;
  return {
    ...(raw.order ? { order: raw.order } : {}),
    ...(raw.only ? { only: raw.only } : {}),
    ...(raw.ignore ? { ignore: raw.ignore } : {}),
    ...(typeof raw.allow_fallbacks === 'boolean' ? { allowFallbacks: raw.allow_fallbacks } : {}),
    ...(sort ? { sort } : {}),
    ...(Object.keys(maxPrice).length > 0 ? { maxPrice } : {}),
  };
}

export const RoutingPolicyScope = z.enum(['organization', 'project', 'key']);
export type RoutingPolicyScope = z.infer<typeof RoutingPolicyScope>;

/** What an administrator sets on one scope. */
export const RoutingPolicy = z.object({
  /** Default provider preferences; a more specific scope overrides a field of a broader one. */
  provider: ProviderPreferences.optional(),
  /**
   * Locks the preferences: the client's `provider` object, `models` fallback list and sorting
   * suffixes are ignored, so a key cannot route around the administrator's choice.
   */
  lockProvider: z.boolean().optional(),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

export const RoutingPolicyRule = RoutingPolicy.extend({
  organizationId: z.string(),
  scope: RoutingPolicyScope,
  scopeId: z.string(),
});
export type RoutingPolicyRule = z.infer<typeof RoutingPolicyRule>;
