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

/** A region code (`eu`, `us`, `asia`, …), lowercase. */
const Region = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/)
  .describe('region code, e.g. eu or us');
/** ISO 3166-1 alpha-2 country code, uppercase. */
const Country = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .describe('ISO 3166-1 alpha-2 country code');

/**
 * Where a provider runs and what it does with request data (card 32.5). Unknown values are treated
 * as the unsafe answer by every policy (no ZDR, may train, no region).
 */
export const ProviderDataPolicy = z.object({
  region: Region.optional(),
  country: Country.optional(),
  /** Zero data retention: the provider keeps no prompts or answers. */
  zdr: z.boolean().optional(),
  /** The provider may use request data to train models. */
  trainsOnData: z.boolean().optional(),
});
export type ProviderDataPolicy = z.infer<typeof ProviderDataPolicy>;

/** Requirements on providers (card 32.5); several are combined to the strictest. */
export const DataPolicy = z.object({
  /** Only providers in these regions. */
  allowedRegions: z.array(Region).max(50).optional(),
  /** Only providers in these countries. */
  allowedCountries: z.array(Country).max(250).optional(),
  /** Only providers with zero data retention. */
  requireZdr: z.boolean().optional(),
  /** Only providers known not to train on request data. */
  denyTraining: z.boolean().optional(),
});
export type DataPolicy = z.infer<typeof DataPolicy>;

/** The strictest combination: lists intersect, requirements add up. */
export function mergeDataPolicies(...policies: (DataPolicy | undefined)[]): DataPolicy {
  const out: DataPolicy = {};
  const intersect = (a: string[] | undefined, b: string[] | undefined) =>
    a === undefined ? b : b === undefined ? a : a.filter((x) => b.includes(x));
  for (const p of policies) {
    if (!p) continue;
    const regions = intersect(out.allowedRegions, p.allowedRegions);
    if (regions) out.allowedRegions = regions;
    const countries = intersect(out.allowedCountries, p.allowedCountries);
    if (countries) out.allowedCountries = countries;
    if (p.requireZdr) out.requireZdr = true;
    if (p.denyTraining) out.denyTraining = true;
  }
  return out;
}

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
  /** `true`: zero-data-retention providers only (card 32.5). `false` cannot relax a policy. */
  zdr: z.boolean().nullish(),
  /** `deny`: only providers that do not train on request data (card 32.5). */
  data_collection: z.enum(['allow', 'deny']).nullish(),
  /** DiRouter extension (card 32.5): only providers in these regions or countries. */
  regions: z.array(Region).max(50).nullish(),
  countries: z.array(Country).max(250).nullish(),
});
export type ProviderRequestObject = z.infer<typeof ProviderRequestObject>;

/** The data requirements of the request form (card 32.5); they can only add restrictions. */
export function dataPolicyFromRequest(raw: ProviderRequestObject): DataPolicy {
  return {
    ...(raw.zdr === true ? { requireZdr: true } : {}),
    ...(raw.data_collection === 'deny' ? { denyTraining: true } : {}),
    ...(raw.regions ? { allowedRegions: raw.regions } : {}),
    ...(raw.countries ? { allowedCountries: raw.countries } : {}),
  };
}

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
  /**
   * Data policy (card 32.5): combined with the other scopes and the request to the strictest; a
   * client can make it stricter, never weaker, whether or not the preferences are locked.
   */
  dataPolicy: DataPolicy.optional(),
  /**
   * Routing explanation (card 32.7): requests that send `x-dirouter-explain: 1` get the routing
   * decision back in the `x-dirouter-routing` header. The most specific scope that sets it wins.
   */
  explain: z.boolean().optional(),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicy>;

export const RoutingPolicyRule = RoutingPolicy.extend({
  organizationId: z.string(),
  scope: RoutingPolicyScope,
  scopeId: z.string(),
});
export type RoutingPolicyRule = z.infer<typeof RoutingPolicyRule>;
