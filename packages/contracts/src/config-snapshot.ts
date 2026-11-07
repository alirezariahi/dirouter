/**
 * ConfigSnapshot: تصویر کامل و نسخه‌دار پیکربندی که control-api منتشر می‌کند و
 * گیت‌وی در حافظه و روی دیسک نگه می‌دارد؛ گیت‌وی هرگز به control plane وابسته نیست.
 *
 * - `schemaVersion` نسخهٔ قالب این اسکیما است و با تغییر ناسازگار بالا می‌رود.
 * - `version` شمارندهٔ یکنواخت انتشار است؛ گیت‌وی snapshot قدیمی‌تر را نمی‌پذیرد.
 * - رازها (کلید provider) فقط به‌صورت رمزشده با MASTER_KEY در snapshot هستند.
 * - یک snapshot همهٔ سازمان‌ها را دارد؛ هر شیء `organizationId` دارد و گیت‌وی
 *   نام مدل را فقط در محدودهٔ سازمانِ کلید resolve می‌کند.
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

/** کلاس‌های خطای upstream (کارت ۵.۲)؛ شرط فال‌بک combo بر اساس همین‌هاست. */
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

/** کلاس‌هایی که به‌صورت پیش‌فرض باعث فال‌بک به هدف بعدی می‌شوند. */
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
  /** زمان تا اولین بایت پاسخ (TTFT). */
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
  organizationId: z.string(),
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

/** قیمت به دلار به ازای یک میلیون توکن (رشتهٔ اعشاری، حداکثر ۸ رقم اعشار). */
export const ModelPricing = z.object({
  inputPerMTok: UsdAmount,
  outputPerMTok: UsdAmount,
  cacheReadPerMTok: UsdAmount.optional(),
  cacheWritePerMTok: UsdAmount.optional(),
  /** اگر نباشد، توکن‌های reasoning با قیمت output حساب می‌شوند. */
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
  /** تعداد کل تلاش روی هر هدف (۱ یعنی بدون retry). */
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
  /** کلاس‌های خطایی که باعث رفتن به هدف بعدی می‌شوند. */
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
    /** درصدهایی که عبور از آن‌ها رویداد هشدار می‌سازد. */
    alertThresholds: z.array(z.int().min(1).max(100)).default([50, 80, 100]),
  })
  .refine((b) => b.limitUsd !== undefined || b.limitTokens !== undefined, {
    message: 'budget needs limitUsd or limitTokens',
  });
export type BudgetConfig = z.infer<typeof BudgetConfig>;

export const VirtualKeyConfig = z.object({
  id: z.string(),
  /** HMAC-SHA256 کلید؛ خود کلید هرگز ذخیره نمی‌شود. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** پیشوند قابل‌نمایش، مثلاً `dr-AbCd1234`. */
  prefix: z.string(),
  organizationId: z.string(),
  teamId: z.string().nullable(),
  projectId: z.string(),
  enabled: z.boolean(),
  expiresAt: IsoDateTime.nullable(),
  /** خالی یعنی همهٔ مدل‌ها؛ در غیر این صورت slug مدل/alias/combo. */
  allowedModels: z.array(z.string()).default([]),
  /** خالی یعنی همهٔ IPها؛ IP یا CIDR (IPv4/IPv6). */
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
  /** رفتار limiter/budget وقتی Valkey در دسترس نیست. */
  failMode: z.enum(['open', 'closed']).default('open'),
  defaultTimeouts: TimeoutConfig.default({}),
  defaultRetry: RetryPolicy.default({ maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 2_000 }),
  logBodies: z.boolean().default(false),
});
export type GatewaySettings = z.infer<typeof GatewaySettings>;

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

/** نسخهٔ ورودی (قبل از اعمال defaultها) برای سازندهٔ snapshot. */
export type ConfigSnapshotInput = z.input<typeof ConfigSnapshot>;
