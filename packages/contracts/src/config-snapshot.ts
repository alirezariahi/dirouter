/**
 * ConfigSnapshot: the complete, versioned configuration image that control-api publishes and
 * the gateway keeps in memory and on disk; the gateway never depends on the control plane.
 *
 * - `schemaVersion` is the format version of this schema and is bumped on breaking changes.
 * - `version` is a monotonic publish counter; the gateway rejects older snapshots.
 * - Secrets (provider keys) are stored in the snapshot only in encrypted form, using MASTER_KEY.
 * - One snapshot covers all organizations; each object has an `organizationId` and the gateway
 *   resolves model names only within the key's organization scope.
 */
import { z } from 'zod';

import { IsoDateTime, Slug, UsdAmount } from './common.js';

export const CONFIG_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const ProviderType = z.enum([
  'openai',
  'azure-openai',
  'openai-compatible',
  'anthropic',
  'gemini',
  'mock',
]);
export type ProviderType = z.infer<typeof ProviderType>;

/** Upstream error classes (card 5.2); combo fallback conditions are based on these. */
export const UpstreamErrorClass = z.enum([
  'rate_limit',
  'overloaded',
  'server',
  'timeout',
  'connection',
  'auth',
  'bad_request',
  'context_length',
  'content_filter',
  'not_found',
]);
export type UpstreamErrorClass = z.infer<typeof UpstreamErrorClass>;

/** Classes that trigger fallback to the next target by default. */
export const DEFAULT_FALLBACK_ON: UpstreamErrorClass[] = [
  'rate_limit',
  'overloaded',
  'server',
  'timeout',
  'connection',
  'auth',
  'not_found',
  'context_length',
];

export const ProxyConfig = z.object({
  url: z.string().regex(/^(https?|socks5h?):\/\//, 'proxy must be http(s):// or socks5://'),
});

export const TimeoutConfig = z.object({
  connectMs: z.int().positive().optional(),
  /** Time to first byte of the response (TTFT). */
  firstByteMs: z.int().positive().optional(),
  /** Maximum silence between two chunks in a stream. */
  idleMs: z.int().positive().optional(),
  totalMs: z.int().positive().optional(),
});
export type TimeoutConfig = z.infer<typeof TimeoutConfig>;

/** A secret encrypted with AES-256-GCM and key versioning (`@dirouter/shared` format). */
export const EncryptedSecret = z.string().regex(/^v\d+\.[A-Za-z0-9_-]+$/, 'invalid ciphertext');

export const CredentialConfig = z.object({
  id: z.string(),
  name: z.string(),
  secret: EncryptedSecret,
  enabled: z.boolean(),
  weight: z.int().min(0).default(1),
  /** Extra headers (e.g. `OpenAI-Organization`). */
  headers: z.record(z.string(), z.string()).default({}),
  /** Outbound proxy for this credential; precedence: credential, then provider, then global (card 4.10). */
  proxy: ProxyConfig.optional(),
});
export type CredentialConfig = z.infer<typeof CredentialConfig>;

export const ProviderConfig = z.object({
  id: z.string(),
  organizationId: z.string(),
  slug: Slug,
  type: ProviderType,
  name: z.string(),
  baseUrl: z.url(),
  enabled: z.boolean(),
  /** Settings specific to the provider type (e.g. `apiVersion` in Azure). */
  options: z.record(z.string(), z.unknown()).default({}),
  proxy: ProxyConfig.optional(),
  timeouts: TimeoutConfig.optional(),
  /** Concurrent request limit (bulkhead). */
  maxConcurrency: z.int().positive().optional(),
  credentials: z.array(CredentialConfig),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** Price in dollars per million tokens (decimal string, at most 8 decimal places). */
export const ModelPricing = z.object({
  inputPerMTok: UsdAmount,
  outputPerMTok: UsdAmount,
  cacheReadPerMTok: UsdAmount.optional(),
  cacheWritePerMTok: UsdAmount.optional(),
  /** If absent, reasoning tokens are priced at the output rate. */
  reasoningPerMTok: UsdAmount.optional(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

export const ModelCapabilities = z.object({
  streaming: z.boolean().default(true),
  tools: z.boolean().default(false),
  vision: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  jsonMode: z.boolean().default(false),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const ModelConfig = z.object({
  id: z.string(),
  organizationId: z.string(),
  /** Public model name in DiRouter, e.g. `openai/gpt-4.1`. */
  slug: Slug,
  providerId: z.string(),
  /** Model name at the provider. */
  upstreamModel: z.string(),
  enabled: z.boolean(),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  pricing: ModelPricing,
  capabilities: ModelCapabilities,
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const RetryPolicy = z.object({
  /** Total attempts per target (1 means no retry). */
  maxAttempts: z.int().min(1).max(10).default(2),
  baseDelayMs: z.int().min(0).default(200),
  maxDelayMs: z.int().min(0).default(2_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const ComboStrategy = z.enum(['priority', 'weighted', 'round-robin']);
export type ComboStrategy = z.infer<typeof ComboStrategy>;

export const ComboConfig = z.object({
  id: z.string(),
  organizationId: z.string(),
  slug: Slug,
  strategy: ComboStrategy,
  targets: z
    .array(
      z.object({
        modelId: z.string(),
        order: z.int().min(0),
        weight: z.int().min(0).default(1),
      }),
    )
    .min(1),
  /** Error classes that cause a move to the next target. */
  fallbackOn: z.array(UpstreamErrorClass).default(DEFAULT_FALLBACK_ON),
  retry: RetryPolicy.optional(),
  timeouts: TimeoutConfig.optional(),
});
export type ComboConfig = z.infer<typeof ComboConfig>;

export const AliasConfig = z.object({
  organizationId: z.string(),
  slug: Slug,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('model'), modelId: z.string() }),
    z.object({ kind: z.literal('combo'), comboId: z.string() }),
  ]),
});
export type AliasConfig = z.infer<typeof AliasConfig>;

export const RateLimitConfig = z.object({
  requestsPerMinute: z.int().positive().optional(),
  tokensPerMinute: z.int().positive().optional(),
  maxConcurrency: z.int().positive().optional(),
});
export type RateLimitConfig = z.infer<typeof RateLimitConfig>;

export const BudgetPeriod = z.enum(['daily', 'monthly']);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

export const BudgetConfig = z
  .object({
    id: z.string(),
    period: BudgetPeriod,
    limitUsd: UsdAmount.optional(),
    limitTokens: z.int().positive().optional(),
    /** Percentages whose crossing creates an alert event. */
    alertThresholds: z.array(z.int().min(1).max(100)).default([50, 80, 100]),
  })
  .refine((b) => b.limitUsd !== undefined || b.limitTokens !== undefined, {
    message: 'budget needs limitUsd or limitTokens',
  });
export type BudgetConfig = z.infer<typeof BudgetConfig>;

export const VirtualKeyConfig = z.object({
  id: z.string(),
  /** HMAC-SHA256 of the key; the key itself is never stored. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Displayable prefix, e.g. `dr-AbCd1234`. */
  prefix: z.string(),
  organizationId: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string(),
  enabled: z.boolean(),
  expiresAt: IsoDateTime.nullable(),
  /** Empty means all models; otherwise the model/alias/combo slug. */
  allowedModels: z.array(z.string()).default([]),
  /** Empty means all IPs; otherwise an IP or CIDR (IPv4/IPv6). */
  ipAllowlist: z.array(z.string()).default([]),
  rateLimit: RateLimitConfig.optional(),
  budgets: z.array(BudgetConfig).default([]),
});
export type VirtualKeyConfig = z.infer<typeof VirtualKeyConfig>;

export const ScopeLimitConfig = z.object({
  organizationId: z.string(),
  scope: z.enum(['team', 'project']),
  scopeId: z.string(),
  rateLimit: RateLimitConfig.optional(),
  budgets: z.array(BudgetConfig).default([]),
});
export type ScopeLimitConfig = z.infer<typeof ScopeLimitConfig>;

export const GatewaySettings = z.object({
  /** Limiter/budget behavior when Valkey is unavailable. */
  failMode: z.enum(['open', 'closed']).default('open'),
  defaultTimeouts: TimeoutConfig.default({}),
  /** Global outbound proxy; a provider or credential can override it. */
  proxy: ProxyConfig.optional(),
  defaultRetry: RetryPolicy.default({ maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 2_000 }),
  logBodies: z.boolean().default(false),
  /** Short bulkhead queue (card 5.7); gateway defaults: 16 waiting and 2 seconds. */
  bulkhead: z
    .object({
      queueSize: z.int().nonnegative().optional(),
      queueTimeoutMs: z.int().nonnegative().optional(),
    })
    .optional(),
});
export type GatewaySettings = z.infer<typeof GatewaySettings>;

export const ConfigSnapshot = z.object({
  schemaVersion: z.literal(CONFIG_SNAPSHOT_SCHEMA_VERSION),
  version: z.int().positive(),
  generatedAt: IsoDateTime,
  /** SHA-256 of the snapshot content (excluding this field), for corruption detection. */
  checksum: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  providers: z.array(ProviderConfig),
  models: z.array(ModelConfig),
  combos: z.array(ComboConfig),
  aliases: z.array(AliasConfig),
  virtualKeys: z.array(VirtualKeyConfig),
  limits: z.array(ScopeLimitConfig).default([]),
  settings: GatewaySettings,
});
export type ConfigSnapshot = z.infer<typeof ConfigSnapshot>;

/** Input version (before defaults are applied) for the snapshot builder. */
export type ConfigSnapshotInput = z.input<typeof ConfigSnapshot>;
