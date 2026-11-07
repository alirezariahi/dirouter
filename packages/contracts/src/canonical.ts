/**
 * مدل canonical داخلی DiRouter.
 *
 * هر ورودی (OpenAI، Anthropic، …) ابتدا به این قالب ترجمه می‌شود و هر آداپتر
 * provider از همین قالب به API مقصد می‌رود؛ پس برای N ورودی و M خروجی فقط
 * N + M مترجم لازم است، نه N × M.
 */
import { z } from 'zod';

import { JsonObject, NonNegativeInt } from './common.js';

// ───────────── Parts ─────────────

export const CanonicalTextPart = z.object({
  type: z.literal('text'),
  text: z.string(),
  /** نشانهٔ cache breakpoint برای providerهایی که prompt caching صریح دارند. */
  cache: z.boolean().optional(),
});

export const CanonicalImagePart = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url: z.string() }),
    z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
  ]),
  detail: z.enum(['auto', 'low', 'high']).optional(),
});

export const CanonicalToolCallPart = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  /** آرگومان‌ها به‌صورت رشتهٔ JSON خام، همان‌طور که مدل تولید کرده. */
  arguments: z.string(),
});

export const CanonicalToolResultPart = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  content: z.array(z.discriminatedUnion('type', [CanonicalTextPart, CanonicalImagePart])),
  isError: z.boolean().optional(),
});

export const CanonicalReasoningPart = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  /** امضای Anthropic برای ارسال دوبارهٔ thinking در نوبت بعد. */
  signature: z.string().optional(),
  /** محتوای رمزشده (redacted_thinking). */
  redacted: z.string().optional(),
});

export const CanonicalPart = z.discriminatedUnion('type', [
  CanonicalTextPart,
  CanonicalImagePart,
  CanonicalToolCallPart,
  CanonicalToolResultPart,
  CanonicalReasoningPart,
]);
export type CanonicalPart = z.infer<typeof CanonicalPart>;

export const CanonicalRole = z.enum(['user', 'assistant', 'tool']);
export type CanonicalRole = z.infer<typeof CanonicalRole>;

export const CanonicalMessage = z.object({
  role: CanonicalRole,
  content: z.array(CanonicalPart),
  name: z.string().optional(),
});
export type CanonicalMessage = z.infer<typeof CanonicalMessage>;

// ───────────── Request ─────────────

export const CanonicalTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: JsonObject,
  strict: z.boolean().optional(),
});
export type CanonicalTool = z.infer<typeof CanonicalTool>;

export const CanonicalToolChoice = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ name: z.string() }),
]);
export type CanonicalToolChoice = z.infer<typeof CanonicalToolChoice>;

export const CanonicalResponseFormat = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    name: z.string(),
    schema: JsonObject,
    strict: z.boolean().optional(),
  }),
]);

/** API ورودی که درخواست با آن رسیده است؛ برای ترجمهٔ پاسخ برعکس لازم است. */
export const InboundApi = z.enum(['openai.chat', 'anthropic.messages']);
export type InboundApi = z.infer<typeof InboundApi>;

export const CanonicalRequest = z.object({
  inboundApi: InboundApi,
  /** نام مدل همان‌طور که کلاینت فرستاده (alias، combo یا مدل). */
  model: z.string(),
  /** دستورالعمل‌های system/developer به ترتیب. */
  system: z.array(CanonicalTextPart),
  messages: z.array(CanonicalMessage),
  tools: z.array(CanonicalTool).optional(),
  toolChoice: CanonicalToolChoice.optional(),
  parallelToolCalls: z.boolean().optional(),
  responseFormat: CanonicalResponseFormat.optional(),
  maxOutputTokens: NonNegativeInt.optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.int().optional(),
  stop: z.array(z.string()).optional(),
  seed: z.int().optional(),
  reasoning: z
    .object({
      effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
      budgetTokens: NonNegativeInt.optional(),
    })
    .optional(),
  stream: z.boolean(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  /** پارامترهای مخصوص provider که ترجمهٔ عمومی ندارند و دست‌نخورده عبور می‌کنند. */
  passthrough: JsonObject.optional(),
});
export type CanonicalRequest = z.infer<typeof CanonicalRequest>;

// ───────────── Response ─────────────

export const CanonicalFinishReason = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'refusal',
  'error',
  'other',
]);
export type CanonicalFinishReason = z.infer<typeof CanonicalFinishReason>;

export const CanonicalUsage = z.object({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  /** توکن‌های ورودی که از prompt cache خوانده شدند (زیرمجموعهٔ inputTokens). */
  cacheReadTokens: NonNegativeInt.default(0),
  /** توکن‌های ورودی که در prompt cache نوشته شدند (زیرمجموعهٔ inputTokens). */
  cacheWriteTokens: NonNegativeInt.default(0),
  /** توکن‌های استدلال (زیرمجموعهٔ outputTokens). */
  reasoningTokens: NonNegativeInt.default(0),
});
export type CanonicalUsage = z.infer<typeof CanonicalUsage>;

export const CanonicalResponse = z.object({
  id: z.string(),
  model: z.string(),
  content: z.array(CanonicalPart),
  finishReason: CanonicalFinishReason,
  /** دلیل خام provider (مثلاً `end_turn`) برای لاگ و دیباگ. */
  rawFinishReason: z.string().optional(),
  usage: CanonicalUsage,
  created: z.int(),
});
export type CanonicalResponse = z.infer<typeof CanonicalResponse>;

// ───────────── Stream ─────────────

export const CanonicalStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), id: z.string(), model: z.string(), created: z.int() }),
  z.object({ type: z.literal('text_delta'), index: z.int(), text: z.string() }),
  z.object({
    type: z.literal('reasoning_delta'),
    index: z.int(),
    text: z.string().optional(),
    signature: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_call_start'),
    index: z.int(),
    id: z.string(),
    name: z.string(),
  }),
  z.object({ type: z.literal('tool_call_delta'), index: z.int(), argumentsDelta: z.string() }),
  z.object({ type: z.literal('content_end'), index: z.int() }),
  z.object({ type: z.literal('usage'), usage: CanonicalUsage }),
  z.object({
    type: z.literal('finish'),
    finishReason: CanonicalFinishReason,
    rawFinishReason: z.string().optional(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
  }),
]);
export type CanonicalStreamEvent = z.infer<typeof CanonicalStreamEvent>;
