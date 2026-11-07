/**
 * اسکیمای Anthropic Messages API (`POST /v1/messages`).
 *
 * مثل اسکیماهای OpenAI، فیلدهای ناشناخته حفظ می‌شوند تا قابلیت‌های جدید
 * (server toolها، بلوک‌های جدید) بدون تغییر گیت‌وی عبور کنند.
 */
import { z } from 'zod';

import { JsonObject, NonNegativeInt } from '../common.js';

// ───────────── Content blocks ─────────────

const CacheControl = z.looseObject({ type: z.literal('ephemeral'), ttl: z.string().optional() });

export const AnthropicTextBlock = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
  cache_control: CacheControl.nullish(),
  citations: z.array(z.unknown()).nullish(),
});

export const AnthropicImageBlock = z.looseObject({
  type: z.literal('image'),
  source: z.discriminatedUnion('type', [
    z.looseObject({
      type: z.literal('base64'),
      media_type: z.string(),
      data: z.string(),
    }),
    z.looseObject({ type: z.literal('url'), url: z.string() }),
    z.looseObject({ type: z.literal('file'), file_id: z.string() }),
  ]),
  cache_control: CacheControl.nullish(),
});

export const AnthropicDocumentBlock = z.looseObject({
  type: z.literal('document'),
  source: z.looseObject({ type: z.string() }),
  title: z.string().nullish(),
  context: z.string().nullish(),
  cache_control: CacheControl.nullish(),
});

export const AnthropicToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  cache_control: CacheControl.nullish(),
});

export const AnthropicToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z
    .union([z.string(), z.array(z.union([AnthropicTextBlock, AnthropicImageBlock]))])
    .optional(),
  is_error: z.boolean().optional(),
  cache_control: CacheControl.nullish(),
});

export const AnthropicThinkingBlock = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string(),
});

export const AnthropicRedactedThinkingBlock = z.looseObject({
  type: z.literal('redacted_thinking'),
  data: z.string(),
});

/** بلوک‌هایی که کلاینت در `messages[].content` می‌فرستد. */
export const AnthropicInputContentBlock = z.discriminatedUnion('type', [
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicDocumentBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicThinkingBlock,
  AnthropicRedactedThinkingBlock,
]);
export type AnthropicInputContentBlock = z.infer<typeof AnthropicInputContentBlock>;

/** بلوک‌هایی که مدل در پاسخ برمی‌گرداند. بلوک‌های ناشناخته (server toolها) هم مجازند. */
export const AnthropicOutputContentBlock = z.union([
  z.discriminatedUnion('type', [
    AnthropicTextBlock,
    AnthropicToolUseBlock,
    AnthropicThinkingBlock,
    AnthropicRedactedThinkingBlock,
  ]),
  z.looseObject({ type: z.string() }),
]);
export type AnthropicOutputContentBlock = z.infer<typeof AnthropicOutputContentBlock>;

// ───────────── Request ─────────────

export const AnthropicMessageParam = z.looseObject({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(AnthropicInputContentBlock)]),
});
export type AnthropicMessageParam = z.infer<typeof AnthropicMessageParam>;

export const AnthropicTool = z.union([
  z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    input_schema: JsonObject,
    type: z.literal('custom').optional(),
    cache_control: CacheControl.nullish(),
  }),
  /** server toolها (web_search، bash، …) با `type` نسخه‌دار. */
  z.looseObject({ type: z.string(), name: z.string() }),
]);
export type AnthropicTool = z.infer<typeof AnthropicTool>;

export const AnthropicToolChoice = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('auto'), disable_parallel_tool_use: z.boolean().optional() }),
  z.looseObject({ type: z.literal('any'), disable_parallel_tool_use: z.boolean().optional() }),
  z.looseObject({
    type: z.literal('tool'),
    name: z.string(),
    disable_parallel_tool_use: z.boolean().optional(),
  }),
  z.looseObject({ type: z.literal('none') }),
]);
export type AnthropicToolChoice = z.infer<typeof AnthropicToolChoice>;

export const AnthropicThinkingConfig = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('enabled'), budget_tokens: z.int().min(1) }),
  z.looseObject({ type: z.literal('disabled') }),
  z.looseObject({ type: z.literal('adaptive') }),
]);

export const AnthropicMessagesRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(AnthropicMessageParam).min(1),
  max_tokens: z.int().min(1),
  system: z.union([z.string(), z.array(AnthropicTextBlock)]).optional(),
  stream: z.boolean().optional(),
  stop_sequences: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.int().min(0).optional(),
  tools: z.array(AnthropicTool).optional(),
  tool_choice: AnthropicToolChoice.optional(),
  thinking: AnthropicThinkingConfig.optional(),
  metadata: z.looseObject({ user_id: z.string().nullish() }).optional(),
  service_tier: z.string().optional(),
});
export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequest>;

// ───────────── Response ─────────────

export const AnthropicStopReason = z.enum([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
]);
export type AnthropicStopReason = z.infer<typeof AnthropicStopReason>;

export const AnthropicUsage = z.looseObject({
  input_tokens: NonNegativeInt,
  output_tokens: NonNegativeInt,
  cache_creation_input_tokens: NonNegativeInt.nullish(),
  cache_read_input_tokens: NonNegativeInt.nullish(),
  service_tier: z.string().nullish(),
});
export type AnthropicUsage = z.infer<typeof AnthropicUsage>;

export const AnthropicMessagesResponse = z.looseObject({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: z.string(),
  content: z.array(AnthropicOutputContentBlock),
  stop_reason: AnthropicStopReason.nullable(),
  stop_sequence: z.string().nullable(),
  usage: AnthropicUsage,
});
export type AnthropicMessagesResponse = z.infer<typeof AnthropicMessagesResponse>;

// ───────────── Stream events ─────────────

export const AnthropicContentBlockDelta = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text_delta'), text: z.string() }),
  z.looseObject({ type: z.literal('input_json_delta'), partial_json: z.string() }),
  z.looseObject({ type: z.literal('thinking_delta'), thinking: z.string() }),
  z.looseObject({ type: z.literal('signature_delta'), signature: z.string() }),
  z.looseObject({ type: z.literal('citations_delta'), citation: z.unknown() }),
]);

export const AnthropicStreamEvent = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('message_start'),
    message: AnthropicMessagesResponse,
  }),
  z.looseObject({
    type: z.literal('content_block_start'),
    index: z.int(),
    content_block: AnthropicOutputContentBlock,
  }),
  z.looseObject({
    type: z.literal('content_block_delta'),
    index: z.int(),
    delta: AnthropicContentBlockDelta,
  }),
  z.looseObject({ type: z.literal('content_block_stop'), index: z.int() }),
  z.looseObject({
    type: z.literal('message_delta'),
    delta: z.looseObject({
      stop_reason: AnthropicStopReason.nullish(),
      stop_sequence: z.string().nullish(),
    }),
    /** در stream فقط output_tokens تجمعی تضمین شده است. */
    usage: z.looseObject({
      output_tokens: NonNegativeInt,
      input_tokens: NonNegativeInt.nullish(),
      cache_creation_input_tokens: NonNegativeInt.nullish(),
      cache_read_input_tokens: NonNegativeInt.nullish(),
    }),
  }),
  z.looseObject({ type: z.literal('message_stop') }),
  z.looseObject({ type: z.literal('ping') }),
  z.looseObject({
    type: z.literal('error'),
    error: z.looseObject({ type: z.string(), message: z.string() }),
  }),
]);
export type AnthropicStreamEvent = z.infer<typeof AnthropicStreamEvent>;
