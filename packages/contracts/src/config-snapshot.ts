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
import { BodyCaptureRule, BodyCaptureSettings } from './request-body.js';

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
  'elevenlabs',
  'deepgram',
  'fal',
  /** A provider plugin from PLUGINS_DIR, named in `options.plugin` (card 21.2). */
  'plugin',
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
/**
 * Higher rates once the prompt is longer than `aboveInputTokens` (card 27.5), e.g. Gemini 2.5 Pro
 * above 200k tokens. The whole request is priced at the tier's rates; unset rates keep the base rate.
 */
export const PricingTier = z.object({
  aboveInputTokens: z.int().positive(),
  inputPerMTok: UsdAmount,
  outputPerMTok: UsdAmount,
  cacheReadPerMTok: UsdAmount.optional(),
  cacheWritePerMTok: UsdAmount.optional(),
});
export type PricingTier = z.infer<typeof PricingTier>;

/** A fraction between 0 and 1 with up to 6 decimals, e.g. `0.5` for half price. */
export const DiscountFraction = z.string().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/);

export const ModelPricing = z.object({
  inputPerMTok: UsdAmount,
  outputPerMTok: UsdAmount,
  cacheReadPerMTok: UsdAmount.optional(),
  cacheWritePerMTok: UsdAmount.optional(),
  /** If absent, reasoning tokens are priced at the output rate. */
  reasoningPerMTok: UsdAmount.optional(),
  /** Images (card 21.1): price per generated image, added to any token price. */
  perImageUsd: UsdAmount.optional(),
  /** Text to speech: price per million input characters. */
  perMCharUsd: UsdAmount.optional(),
  /** Speech to text: price per second of input audio. */
  perSecondUsd: UsdAmount.optional(),
  /**
   * Realtime audio tokens (card 30.5), per million. Unset means the text input/output rate;
   * cached audio is priced at `cacheReadPerMTok` like cached text.
   */
  audioInputPerMTok: UsdAmount.optional(),
  audioOutputPerMTok: UsdAmount.optional(),
  /** Context-length tiers (card 27.5), ascending by threshold. */
  tiers: z.array(PricingTier).max(8).optional(),
  /** Discount for the provider's batch API (card 27.5): `0.5` = batch calls cost half. */
  batchDiscount: DiscountFraction.optional(),
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
  /** `/v1/images/generations`, `/v1/audio/speech` and `/v1/audio/transcriptions` (card 21.1). */
  images: z.boolean().optional(),
  speech: z.boolean().optional(),
  transcription: z.boolean().optional(),
  /**
   * Chat input beyond text and images (card 27.2): PDF and other documents, and audio. `false`
   * keeps such requests away from the model; unset means "whatever the provider type supports".
   */
  documents: z.boolean().optional(),
  audioInput: z.boolean().optional(),
  /** Model can serve Realtime WebSocket sessions at `/v1/realtime` (card 30.5). */
  realtime: z.boolean().optional(),
  /**
   * The provider serves the legacy `/v1/completions` for this model itself (instruct models,
   * vLLM). Otherwise the gateway maps the request to chat (card 30.4).
   */
  completions: z.boolean().optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

const Multiplier = z.string().regex(/^\d{1,6}(\.\d{1,8})?$/);

/**
 * Sale price of a model (card 19.4). What a customer pays is
 * `cost × multiplier × the customer group's multiplier`, or `perRequestUsd × group multiplier`
 * when a fixed price per request is set (images, video). A response served from DiRouter's own
 * cache costs nothing upstream and is sold at `cacheMultiplier` times the normal price (0 = free).
 */
export const SalePrice = z.object({
  multiplier: Multiplier.default('1'),
  perRequestUsd: UsdAmount.optional(),
  cacheMultiplier: Multiplier.default('0'),
});
export type SalePrice = z.infer<typeof SalePrice>;

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
  /** Platform model sold to customer organizations (marketplace, card 19.4). */
  public: z.boolean().optional(),
  sale: SalePrice.optional(),
  /** Provider's announced retirement date, `YYYY-MM-DD` (card 27.5). */
  deprecationDate: z.iso.date().optional(),
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
  /** Platform combo offered to customer organizations (card 19.4). */
  public: z.boolean().optional(),
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
  /** Customer group multiplier applied to sale prices (card 19.4); absent means 1. */
  priceMultiplier: Multiplier.optional(),
  /**
   * MCP tools this key may see and call (card 20.1): `server__tool`, `server__*` or `*`.
   * Empty means every tool of the organization's MCP servers.
   */
  mcpTools: z.array(z.string()).default([]),
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
  /**
   * Span attribute names (card 24.3): `both` (default) adds the OpenTelemetry GenAI semantic
   * conventions (`gen_ai.*`) next to the original `gateway.*` names, `gen_ai` sends only the
   * conventions, `legacy` only the original names and span names, as before.
   */
  attributes: z.enum(['both', 'gen_ai', 'legacy']).default('both'),
  /** OTLP/HTTP metrics export (card 24.3), alongside the Prometheus endpoint. */
  metrics: z
    .object({
      enabled: z.boolean().default(false),
      /** e.g. http://otel-collector:4318/v1/metrics */
      endpoint: z.string().optional(),
      intervalSeconds: z.int().min(5).max(3_600).default(30),
    })
    .optional(),
  /** OTLP/HTTP logs export (card 24.3): the same JSON lines the gateway writes to stdout. */
  logs: z
    .object({
      enabled: z.boolean().default(false),
      /** e.g. http://otel-collector:4318/v1/logs */
      endpoint: z.string().optional(),
      level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    })
    .optional(),
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
  /**
   * Automatic model choice (card 20.4) for the aliases `auto`, `auto/coding`, `auto/smart`,
   * `auto/fast` and `auto/cheap`. Targets are model, alias or combo names as clients use them.
   */
  autoRouting: z
    .object({
      enabled: z.boolean().default(false),
      /** Where `auto` sends each task type; `smart` is also `auto/smart`, `coding` is `auto/coding`. */
      targets: z
        .object({
          coding: z.string().min(1).optional(),
          reasoning: z.string().min(1).optional(),
          summarization: z.string().min(1).optional(),
          chat: z.string().min(1).optional(),
          smart: z.string().min(1).optional(),
        })
        .default({}),
      /** Candidates for `auto/fast` and `auto/cheap`, and the fallback when a target lacks a capability. */
      pool: z.array(z.string().min(1)).default([]),
      /** Optional small model asked when the rules are unsure (confidence below the threshold). */
      classifierModel: z.string().min(1).optional(),
      classifierThreshold: z.number().min(0).max(1).default(0.5),
    })
    .optional(),
  /** DiRouter as an A2A agent (card 20.3): the model that answers when a request names none. */
  a2a: z.object({ defaultModel: z.string().min(1).optional() }).optional(),
  /** Limiter/budget behavior when Valkey is unavailable. */
  failMode: z.enum(['open', 'closed']).default('open'),
  defaultTimeouts: TimeoutConfig.default({}),
  /** Global outbound proxy; a provider or credential can override it. */
  proxy: ProxyConfig.optional(),
  defaultRetry: RetryPolicy.default({ maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 2_000 }),
  /**
   * Instance-wide default of request body capture (card 24.1): `true` means `full` for keys whose
   * organization, project and key have no level of their own. `bodyCapture.defaultLevel` wins.
   */
  logBodies: z.boolean().default(false),
  /** Request body capture (card 24.1): default level and size cap of each stored part. */
  bodyCapture: BodyCaptureSettings.optional(),
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

/** An upstream MCP server the gateway aggregates under /mcp (card 20.1). */
export const McpServerConfig = z.object({
  id: z.string(),
  organizationId: z.string(),
  /** Tool name prefix: tools appear as `<slug>__<tool>`. */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  /**
   * `streamable-http` (current MCP transport), `sse` (the older HTTP+SSE transport), or `a2a`: an
   * external A2A agent (card 20.3) proxied at /a2a/agents/<slug>; `url` is its JSON-RPC endpoint.
   */
  transport: z.enum(['streamable-http', 'sse', 'a2a']),
  url: z.url(),
  enabled: z.boolean(),
  /** Encrypted with MASTER_KEY (AAD `mcp:<id>`): a JSON object of headers, e.g. Authorization. */
  headers: z.string().optional(),
  /**
   * Encrypted with MASTER_KEY (AAD `mcp-oauth:<id>`): the organization's shared OAuth credential
   * for an OAuth-protected server (card 28.1), a JSON `McpOAuthConfig`.
   */
  oauth: z.string().optional(),
  /** Send the caller's organization, project and key ids as X-DiRouter-* headers. */
  forwardIdentity: z.boolean().default(false),
  timeoutMs: z.int().positive().max(300_000).default(60_000),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

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
  /**
   * The operator's organization (card 19.4): customer keys that do not find a name in their own
   * organization fall back to its public models and combos.
   */
  platformOrganizationId: z.string().optional(),
  mcpServers: z.array(McpServerConfig).default([]),
  /** Request body capture levels per organization, project or key (card 24.1). */
  bodyCapture: z.array(BodyCaptureRule).default([]),
});
export type ConfigSnapshot = z.infer<typeof ConfigSnapshot>;

/** Input version (before defaults are applied) for the snapshot builder. */
export type ConfigSnapshotInput = z.input<typeof ConfigSnapshot>;
