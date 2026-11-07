/**
 * ConfigSnapshot: تصویر کامل و نسخه‌دار پیکربندی که control-api منتشر می‌کند و
 * گیت‌وی در حافظه و روی دیسک نگه می‌دارد؛ گیت‌وی هرگز به control plane وابسته نیست.
 *
 * - `schemaVersion` نسخهٔ قالب این اسکیما است و با تغییر ناسازگار بالا می‌رود.
 * - `version` شمارندهٔ یکنواخت انتشار است؛ گیت‌وی snapshot قدیمی‌تر را نمی‌پذیرد.
 * - رازها (کلید provider) فقط به‌صورت رمزشده با MASTER_KEY در snapshot هستند.
 */
import { z } from 'zod';

import { IsoDateTime, NonNegativeInt, Slug } from './common.js';

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

export const ProxyConfig = z.object({
  url: z.string().regex(/^(https?|socks5h?):\/\//, 'proxy must be http(s):// or socks5://'),
  /** میزبان‌هایی که نباید از proxy عبور کنند. */
  noProxy: z.array(z.string()).default([]),
});

export const TimeoutConfig = z.object({
  connectMs: z.int().positive().optional(),
  /** زمان تا اولین توکن (TTFT). */
  firstByteMs: z.int().positive().optional(),
  /** حداکثر سکوت بین دو chunk در stream. */
  idleMs: z.int().positive().optional(),
  totalMs: z.int().positive().optional(),
});
export type TimeoutConfig = z.infer<typeof TimeoutConfig>;

/** رازی که با AES-256-GCM و key versioning رمز شده (قالب `@dirouter/shared`). */
export const EncryptedSecret = z.string().regex(/^v\d+\.[A-Za-z0-9_-]+$/, 'invalid ciphertext');

export const CredentialConfig = z.object({
  id: z.string(),
  name: z.string(),
  secret: EncryptedSecret,
  enabled: z.boolean(),
  weight: z.int().min(0).default(1),
  /** هدرهای اضافه (مثلاً `OpenAI-Organization`). */
  headers: z.record(z.string(), z.string()).default({}),
});
export type CredentialConfig = z.infer<typeof CredentialConfig>;

export const ProviderConfig = z.object({
  id: z.string(),
  slug: Slug,
  type: ProviderType,
  name: z.string(),
  baseUrl: z.url(),
  enabled: z.boolean(),
  /** تنظیمات مخصوص نوع provider (مثلاً `apiVersion` در Azure). */
  options: z.record(z.string(), z.unknown()).default({}),
  proxy: ProxyConfig.optional(),
  timeouts: TimeoutConfig.optional(),
  /** سقف درخواست هم‌زمان (bulkhead). */
  maxConcurrency: z.int().positive().optional(),
  credentials: z.array(CredentialConfig),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

/** قیمت به میکرودلار به ازای یک میلیون توکن؛ عدد صحیح تا خطای ممیز شناور نداشته باشیم. */
export const ModelPricing = z.object({
  inputPerMTokMicros: NonNegativeInt,
  outputPerMTokMicros: NonNegativeInt,
  cacheReadPerMTokMicros: NonNegativeInt.optional(),
  cacheWritePerMTokMicros: NonNegativeInt.optional(),
});
export type ModelPricing = z.infer<typeof ModelPricing>;

export const ModelCapabilities = z.object({
  streaming: z.boolean().default(true),
  tools: z.boolean().default(false),
  vision: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  jsonMode: z.boolean().default(false),
});

export const ModelConfig = z.object({
  id: z.string(),
  /** نام عمومی مدل در DiRouter، مثلاً `openai/gpt-4.1`. */
  slug: Slug,
  providerId: z.string(),
  /** نام مدل نزد provider. */
  upstreamModel: z.string(),
  enabled: z.boolean(),
  contextWindow: z.int().positive().optional(),
  maxOutputTokens: z.int().positive().optional(),
  pricing: ModelPricing,
  capabilities: ModelCapabilities,
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const RetryPolicy = z.object({
  maxAttempts: z.int().min(1).max(10).default(2),
  baseDelayMs: z.int().min(0).default(200),
  maxDelayMs: z.int().min(0).default(2_000),
});

export const ComboStrategy = z.enum(['priority', 'round-robin', 'weighted', 'random']);
export type ComboStrategy = z.infer<typeof ComboStrategy>;

export const ComboConfig = z.object({
  id: z.string(),
  slug: Slug,
  strategy: ComboStrategy,
  targets: z
    .array(
      z.object({
        modelId: z.string(),
        priority: z.int().min(0).default(0),
        weight: z.int().min(0).default(1),
      }),
    )
    .min(1),
  retry: RetryPolicy.optional(),
  timeouts: TimeoutConfig.optional(),
});
export type ComboConfig = z.infer<typeof ComboConfig>;

export const AliasConfig = z.object({
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

export const BudgetConfig = z.object({
  limitMicros: NonNegativeInt,
  period: z.enum(['daily', 'weekly', 'monthly', 'total']),
});

export const VirtualKeyConfig = z.object({
  id: z.string(),
  /** HMAC-SHA256 کلید؛ خود کلید هرگز ذخیره نمی‌شود. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** پیشوند قابل‌نمایش، مثلاً `dr-live-AbCd`. */
  prefix: z.string(),
  orgId: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string(),
  enabled: z.boolean(),
  expiresAt: IsoDateTime.nullable(),
  /** خالی یعنی همهٔ مدل‌ها؛ در غیر این صورت slug مدل/alias/combo. */
  allowedModels: z.array(z.string()).default([]),
  rateLimit: RateLimitConfig.optional(),
  budget: BudgetConfig.optional(),
});
export type VirtualKeyConfig = z.infer<typeof VirtualKeyConfig>;

export const ScopeLimitConfig = z.object({
  scope: z.enum(['org', 'team', 'project']),
  scopeId: z.string(),
  rateLimit: RateLimitConfig.optional(),
  budget: BudgetConfig.optional(),
});

export const GatewaySettings = z.object({
  /** رفتار limiter/budget وقتی Valkey در دسترس نیست. */
  failMode: z.enum(['open', 'closed']).default('open'),
  defaultTimeouts: TimeoutConfig.default({}),
  defaultRetry: RetryPolicy.default({ maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 2_000 }),
  logBodies: z.boolean().default(false),
});

export const ConfigSnapshot = z.object({
  schemaVersion: z.literal(CONFIG_SNAPSHOT_SCHEMA_VERSION),
  version: z.int().positive(),
  generatedAt: IsoDateTime,
  /** SHA-256 محتوای snapshot (بدون این فیلد) برای تشخیص خرابی. */
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
