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
import { GuardrailPolicy } from './guardrails.js';

export const CONFIG_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export { HedgingBudgetSchema } from './hedging.js';
export type { HedgeBudgetOptions } from './hedging.js';

export const ProviderType = z.enum([
  'openai',
  'azure-openai',
  'openai-compatible',
  'anthropic',
  'gemini',
  'bedrock',
  'vertex',
  'cohere',
  'mistral',
  'voyage',
  'jina',
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
  /** Model can serve `/v1/embeddings` (card 11.4). */
  embeddings: z.boolean().default(false),
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

/**
 * Combo ordering strategies (card 12.1):
 * - `priority`: target order
 * - `weighted`: weighted random
 * - `round-robin`: rotate the starting target
 * - `latency`: lowest observed EWMA latency first
 * - `cost`: lowest estimated price for the request first
 * - `least-used`: fewest recent requests first (spreads load)
 * - `headroom`: most remaining context capacity first
 */
export const ComboStrategy = z.enum([
  'priority',
  'weighted',
  'round-robin',
  'latency',
  'cost',
  'least-used',
  'headroom',
]);
export type ComboStrategy = z.infer<typeof ComboStrategy>;

/** Hedged requests (card 12.2): fire a second target if the first is slow. */
export const HedgingConfig = z.object({
  enabled: z.boolean().default(false),
  /** Delay before the hedge request starts. */
  afterMs: z.int().positive().default(800),
  /** Maximum concurrent attempts for one client request. */
  maxParallel: z.int().min(2).max(4).default(2),
  /** Share of traffic allowed to hedge in the rolling window; 0 disables hedging. */
  maxRatio: z.number().min(0).max(1).default(0.2),
  windowMs: z.int().positive().default(60_000),
});
export type HedgingConfig = z.infer<typeof HedgingConfig>;

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
  hedging: HedgingConfig.optional(),
  /** Keep a client/session on the same target when health allows (card 12.4). */
  sticky: z.boolean().default(false),
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
  /** Prepaid organizations: the wallet the gateway reserves credit from (card 19.1). */
  walletId: z.string().optional(),
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

export const CacheSettings = z.object({
  exact: z
    .object({
      enabled: z.boolean().default(false),
      ttlSeconds: z.int().positive().default(300),
      /** Responses with more output tokens than this are not cached. */
      maxOutputTokens: z.int().positive().default(4_096),
      /** Only cache requests whose temperature is at most this value. */
      maxTemperature: z.number().min(0).max(2).default(0.2),
    })
    .optional(),
  semantic: z
    .object({
      enabled: z.boolean().default(false),
      ttlSeconds: z.int().positive().default(3_600),
      /** Cosine similarity threshold (0..1). */
      threshold: z.number().min(0).max(1).default(0.95),
      /** Semantic cache lives in control-api (pgvector); fail-open on timeout. */
      timeoutMs: z.int().positive().default(150),
      /** Embedding model for all projects; defaults to control-api's SEMANTIC_CACHE_EMBEDDING_MODEL. */
      embeddingModel: z.string().min(1).max(200).optional(),
      /** Per-project overrides, keyed by project id (card 13.2). */
      projects: z
        .record(
          z.string(),
          z.object({
            enabled: z.boolean().optional(),
            threshold: z.number().min(0).max(1).optional(),
            embeddingModel: z.string().min(1).max(200).optional(),
          }),
        )
        .default({}),
    })
    .optional(),
});
export type CacheSettings = z.infer<typeof CacheSettings>;

export const CompressionSettings = z.object({
  enabled: z.boolean().default(false),
  /** Remove duplicate messages and repeated tool results (card 13.3). */
  dedupe: z.boolean().default(true),
  /** Truncate older tool results to this many characters. */
  maxToolResultChars: z.int().positive().default(2_000),
  /** Never compress the last N messages. */
  keepRecentMessages: z.int().positive().default(4),
  /** Drop reasoning blocks from earlier turns (they cannot be replayed reliably). */
  dropOldReasoning: z.boolean().default(true),
});
export type CompressionSettings = z.infer<typeof CompressionSettings>;

export const TracingSettings = z.object({
  enabled: z.boolean().default(false),
  /** OTLP/HTTP endpoint (e.g. http://otel-collector:4318/v1/traces). */
  endpoint: z.string().optional(),
  serviceName: z.string().default('dirouter-gateway'),
  sampleRatio: z.number().min(0).max(1).default(0.1),
});
export type TracingSettings = z.infer<typeof TracingSettings>;

/** Periodic upstream health probes (card 12.3). Off by default: every probe is a real upstream call. */
export const HealthProbeSettings = z.object({
  enabled: z.boolean().default(false),
  /** Seconds between probe rounds; one replica probes per round (Valkey lock). */
  intervalSeconds: z.int().min(10).max(86_400).default(60),
  /** Consecutive failed probes before a credential is taken out of rotation. */
  failureThreshold: z.int().min(1).max(20).default(3),
  /** Consecutive successful probes before a probe-disabled credential returns. */
  successThreshold: z.int().min(1).max(20).default(1),
  /** Upper bound of credentials probed per round; the rest wait for the next round. */
  maxPerRound: z.int().min(1).max(1_000).default(50),
});
export type HealthProbeSettings = z.infer<typeof HealthProbeSettings>;

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
  /** Response caching (card 13.1 and 13.2). */
  cache: CacheSettings.optional(),
  /** Context compaction (card 13.3). */
  compression: CompressionSettings.optional(),
  /** OpenTelemetry traces (card 17.2). */
  tracing: TracingSettings.optional(),
  /** Sticky sessions for combos (card 12.4). */
  sessionAffinity: z
    .object({
      enabled: z.boolean().default(false),
      header: z.string().default('x-dirouter-session'),
      ttlSeconds: z.int().positive().default(3_600),
    })
    .optional(),
  /** Periodic upstream health probes (card 12.3). */
  healthProbe: HealthProbeSettings.optional(),
  /** Local breaker thresholds (card 12.x); defaults from DEFAULT_BREAKER. */
  breaker: z
    .object({
      errorThreshold: z.number().min(0.01).max(1).optional(),
      minRequests: z.int().positive().optional(),
      openMs: z.int().positive().optional(),
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
  /** Guardrail policies evaluated by the gateway (card 15.1). */
  guardrails: z.array(GuardrailPolicy).default([]),
  settings: GatewaySettings,
});
export type ConfigSnapshot = z.infer<typeof ConfigSnapshot>;

/** Input version (before defaults are applied) for the snapshot builder. */
export type ConfigSnapshotInput = z.input<typeof ConfigSnapshot>;
