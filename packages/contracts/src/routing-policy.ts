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

// ───────────── Conditional routing rules (card 32.2) ─────────────

import { UsdAmount } from './common.js';

/** What a matching rule does. `route` and `reject` end the evaluation; `tag` adds labels and goes on. */
export const RoutingRuleAction = z.discriminatedUnion('type', [
  /** Send the request to a model, alias, combo or `auto*` name of the organization instead. */
  z.object({ type: z.literal('route'), target: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('reject'),
    message: z.string().max(500).optional(),
    status: z.union([z.literal(400), z.literal(403), z.literal(429)]).default(403),
  }),
  /** Labels recorded with the request (usage event and request log). */
  z.object({
    type: z.literal('tag'),
    tags: z
      .record(z.string().regex(/^[a-z0-9_.-]{1,40}$/), z.string().max(100))
      .refine((t) => Object.keys(t).length > 0 && Object.keys(t).length <= 10, {
        message: 'a tag action needs 1 to 10 tags',
      }),
  }),
]);
export type RoutingRuleAction = z.infer<typeof RoutingRuleAction>;

export const RoutingRuleConfig = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  /** Lower runs first. */
  priority: z.int().min(0).max(1_000_000),
  /** A team's own policy: the rule only applies to keys of this team (card 32.2). */
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  /** CEL-subset condition, see `@dirouter/routing` rules-expr. */
  condition: z.string().min(1).max(2_000),
  action: RoutingRuleAction,
});
export type RoutingRuleConfig = z.infer<typeof RoutingRuleConfig>;

/** How the policies changed a request, recorded with its usage event (sprint 5). */
export const PolicyTrace = z.object({
  rules: z
    .object({
      /** Every rule that matched, in evaluation order. */
      matched: z.array(z.string()),
      /** The rule whose `route` or `reject` decided the request. */
      decidedBy: z.string().optional(),
      target: z.string().optional(),
      tags: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** The traffic split that chose the branch (card 32.3). */
  split: z
    .object({ id: z.string(), version: z.int(), branch: z.enum(['stable', 'canary']) })
    .optional(),
});
export type PolicyTrace = z.infer<typeof PolicyTrace>;

/** Automatic rollback of a canary (card 32.3): the canary's error rate over a rolling window. */
export const SplitAutoRollback = z.object({
  enabled: z.boolean().default(true),
  /** Share of failed canary requests (0..1) that rolls the split back. */
  errorRate: z.number().gt(0).max(1).default(0.2),
  /** Canary requests the window needs before it may decide. */
  minRequests: z.int().min(1).max(100_000).default(20),
  windowSeconds: z.int().min(10).max(3_600).default(60),
});
export type SplitAutoRollback = z.infer<typeof SplitAutoRollback>;

/**
 * Canary and percentage traffic split (card 32.3): requests for `match` go to `canary` for
 * `canaryPercent` of the traffic and to `stable` for the rest. The branch is sticky per key, per
 * session or chosen per request. Every change is a new `version`; a rolled-back split sends
 * everything to `stable`.
 */
export const TrafficSplitConfig = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  version: z.int().positive(),
  /** The name clients (or a routing rule) ask for. */
  match: z.string().min(1).max(200),
  stable: z.string().min(1).max(200),
  canary: z.string().min(1).max(200),
  /** 0..100 with up to two decimals. */
  canaryPercent: z.number().min(0).max(100),
  stickiness: z.enum(['key', 'session', 'request']).default('key'),
  autoRollback: SplitAutoRollback.optional(),
  state: z.enum(['active', 'rolled_back']).default('active'),
});
export type TrafficSplitConfig = z.infer<typeof TrafficSplitConfig>;

/** Valkey list the gateway pushes automatic rollbacks to; control-api persists them. */
export const SPLIT_ROLLBACKS_KEY = 'dirouter:splits:rollbacks';
/** Valkey flag of a rolled-back split version, read by every gateway replica. */
export const splitRolledBackKey = (splitId: string, version: number): string =>
  `dirouter:split:rolledback:${splitId}:${String(version)}`;

export const SplitRollbackEvent = z.object({
  splitId: z.string(),
  organizationId: z.string(),
  version: z.int(),
  errorRate: z.number(),
  requests: z.int(),
  at: z.string(),
});
export type SplitRollbackEvent = z.infer<typeof SplitRollbackEvent>;

/**
 * Shadow traffic (card 32.4): a sampled copy of matching requests goes to `target` after the
 * client has its answer. The copy's answer is thrown away; its cost is recorded apart from the
 * customer's usage, never counts against the key's, project's or team's budget or wallet, and
 * stops for the day once `dailyBudgetUsd` is spent. The target must be one of the organization's
 * own models: the organization pays its own provider for the experiment.
 */
export const ShadowPolicyConfig = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string().min(1).max(100),
  enabled: z.boolean().default(true),
  /** The name clients ask for, or `*` for every request of the organization. */
  match: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  /** Share of matching requests that are mirrored (0..1). */
  sampleRate: z.number().min(0).max(1),
  dailyBudgetUsd: UsdAmount,
  /** Only this project's requests (optional). */
  projectId: z.string().optional(),
  timeoutMs: z.int().min(1_000).max(300_000).default(60_000),
});
export type ShadowPolicyConfig = z.infer<typeof ShadowPolicyConfig>;

/** What a shadow usage event compares against: the request the client got an answer to. */
export const ShadowTrace = z.object({
  policyId: z.string(),
  /** The client's request (the usage event's own requestId is `<primary>:shadow`). */
  primaryRequestId: z.string(),
  primaryModel: z.string().nullable(),
  primaryStatus: z.int(),
  primaryLatencyMs: z.int().nonnegative(),
  primaryCostUsd: UsdAmount,
});
export type ShadowTrace = z.infer<typeof ShadowTrace>;

/** Valkey counter of a shadow policy's spend per UTC day, in 1e-8 dollars. */
export const shadowSpendKey = (policyId: string, day: string): string =>
  `dirouter:shadow:spend:${policyId}:${day}`;

/** How much `auto*` routing may spend (card 32.8); thresholds are in the gateway settings. */
export const AutoCostTier = z.enum(['low', 'medium', 'high']);
export type AutoCostTier = z.infer<typeof AutoCostTier>;

/** Model slug or a glob with `*` (e.g. `openai/*`). */
const ModelPattern = z.string().min(1).max(200);

/**
 * Controls of automatic routing (card 32.8) for an organization or one key. The cost tier keeps
 * `auto*` away from models priced above it; the allowed and denied sets name the models it may
 * pick. An organization policy with `locked` set is an administrator's ceiling: a key policy can
 * then only narrow it (the cheaper tier, both allowed sets, every denied model), never widen it.
 */
export const AutoRoutingPolicyConfig = z.object({
  organizationId: z.string(),
  scope: z.enum(['organization', 'key']),
  /** The organization id or the key id. */
  scopeId: z.string(),
  costTier: AutoCostTier.optional(),
  /** Empty means every model. */
  allowedModels: z.array(ModelPattern).max(200).default([]),
  deniedModels: z.array(ModelPattern).max(200).default([]),
  /** Organization scope only: keys cannot widen this policy. */
  locked: z.boolean().default(false),
  /** `auto` lets automatic routing pick a reasoning effort when the client sent none. */
  reasoningEffort: z.enum(['auto', 'off']).default('auto'),
});
export type AutoRoutingPolicyConfig = z.infer<typeof AutoRoutingPolicyConfig>;
