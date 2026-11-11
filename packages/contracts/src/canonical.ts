/**
 * DiRouter's internal canonical model.
 *
 * Every inbound format (OpenAI, Anthropic, …) is first translated into this canonical format, and each
 * provider adapter translates from it to the target API; so for N inbound and M outbound formats only
 * N + M translators are needed, not N × M.
 */
import { z } from 'zod';

import { JsonObject, NonNegativeInt } from './common.js';

// ───────────── Parts ─────────────

export const CanonicalTextPart = z.object({
  type: z.literal('text'),
  text: z.string(),
  /** Cache breakpoint marker for providers that support explicit prompt caching. */
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
  /** Arguments as a raw JSON string, exactly as the model produced them. */
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
  /** Anthropic signature for resending thinking in the next turn. */
  signature: z.string().optional(),
  /** Encrypted content (redacted_thinking). */
  redacted: z.string().optional(),
});

export type CanonicalTextPart = z.infer<typeof CanonicalTextPart>;
export type CanonicalImagePart = z.infer<typeof CanonicalImagePart>;
export type CanonicalToolCallPart = z.infer<typeof CanonicalToolCallPart>;
export type CanonicalToolResultPart = z.infer<typeof CanonicalToolResultPart>;
export type CanonicalReasoningPart = z.infer<typeof CanonicalReasoningPart>;

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

/** The inbound API the request arrived through; needed to translate the response back. */
export const InboundApi = z.enum(['openai.chat', 'anthropic.messages']);
export type InboundApi = z.infer<typeof InboundApi>;

export const CanonicalRequest = z.object({
  inboundApi: InboundApi,
  /** Model name as sent by the client (alias, combo, or model). */
  model: z.string(),
  /** System/developer instructions, in order. */
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
  /** Provider-specific parameters that have no generic translation and pass through unchanged. */
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
  /** Input tokens read from the prompt cache (subset of inputTokens). */
  cacheReadTokens: NonNegativeInt.default(0),
  /** Input tokens written to the prompt cache (subset of inputTokens). */
  cacheWriteTokens: NonNegativeInt.default(0),
  /** Reasoning tokens (subset of outputTokens). */
  reasoningTokens: NonNegativeInt.default(0),
});
export type CanonicalUsage = z.infer<typeof CanonicalUsage>;

export const CanonicalResponse = z.object({
  id: z.string(),
  model: z.string(),
  content: z.array(CanonicalPart),
  finishReason: CanonicalFinishReason,
  /** Raw stop reason from the provider (e.g. `end_turn`), for logging and debugging. */
  rawFinishReason: z.string().optional(),
  /** If absent, the provider returned no usage and the gateway must estimate it (card 6.2). */
  usage: CanonicalUsage.optional(),
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
