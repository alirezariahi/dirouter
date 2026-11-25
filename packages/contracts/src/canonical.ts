/**
 * DiRouter's internal canonical model.
 *
 * Every inbound format (OpenAI, Anthropic, …) is first translated into this canonical format, and each
 * provider adapter translates from it to the target API; so for N inbound and M outbound formats only
 * N + M translators are needed, not N × M.
 */
import { z } from 'zod';

import { JsonObject, NonNegativeInt, UsdAmount } from './common.js';

// ───────────── Parts ─────────────

/**
 * Prompt-cache breakpoint (card 27.3): the provider caches the prompt up to and including this
 * block. `cacheTtl` is the requested lifetime (`5m` or `1h`); unset means the provider default.
 * Kept on system text, tools, text, images, documents, tool calls and tool results.
 */
const CacheMarker = {
  cache: z.boolean().optional(),
  cacheTtl: z.string().optional(),
};

export const CanonicalTextPart = z.object({
  type: z.literal('text'),
  text: z.string(),
  ...CacheMarker,
});

export const CanonicalImagePart = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url: z.string() }),
    z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
  ]),
  detail: z.enum(['auto', 'low', 'high']).optional(),
  ...CacheMarker,
});

/**
 * A document (card 27.2): PDF or another file, inline (`base64`), by URL, as plain text, or as a
 * provider file id (`file`), which only the provider that issued it can read.
 */
export const CanonicalDocumentPart = z.object({
  type: z.literal('document'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
    z.object({ kind: z.literal('url'), url: z.string(), mediaType: z.string().optional() }),
    z.object({ kind: z.literal('text'), text: z.string(), mediaType: z.string().optional() }),
    z.object({
      kind: z.literal('file'),
      fileId: z.string(),
      /** The API family that issued the id. */
      origin: z.enum(['openai', 'anthropic']),
    }),
  ]),
  filename: z.string().optional(),
  title: z.string().optional(),
  /** Anthropic `context`: text about the document that is not part of it. */
  context: z.string().optional(),
  /** Anthropic citations requested for this document. */
  citations: z.boolean().optional(),
  ...CacheMarker,
});

/** Audio input (card 27.2), inline (`base64`, e.g. `audio/wav`) or by URL. */
export const CanonicalAudioPart = z.object({
  type: z.literal('audio'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
    z.object({ kind: z.literal('url'), url: z.string(), mediaType: z.string().optional() }),
  ]),
});

export const CanonicalToolCallPart = z.object({
  type: z.literal('tool_call'),
  id: z.string(),
  name: z.string(),
  /** Arguments as a raw JSON string, exactly as the model produced them. */
  arguments: z.string(),
  ...CacheMarker,
});

export const CanonicalToolResultPart = z.object({
  type: z.literal('tool_result'),
  toolCallId: z.string(),
  content: z.array(z.discriminatedUnion('type', [CanonicalTextPart, CanonicalImagePart])),
  isError: z.boolean().optional(),
  ...CacheMarker,
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
export type CanonicalDocumentPart = z.infer<typeof CanonicalDocumentPart>;
export type CanonicalAudioPart = z.infer<typeof CanonicalAudioPart>;
export type CanonicalToolCallPart = z.infer<typeof CanonicalToolCallPart>;
export type CanonicalToolResultPart = z.infer<typeof CanonicalToolResultPart>;
export type CanonicalReasoningPart = z.infer<typeof CanonicalReasoningPart>;

export const CanonicalPart = z.discriminatedUnion('type', [
  CanonicalTextPart,
  CanonicalImagePart,
  CanonicalDocumentPart,
  CanonicalAudioPart,
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
  ...CacheMarker,
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
export const InboundApi = z.enum([
  'openai.chat',
  'anthropic.messages',
  'openai.responses',
  'gemini.generate',
  'openai.embeddings',
  'openai.moderations',
  'openai.images',
  'openai.speech',
  'openai.transcriptions',
  /** A finished batch (card 30.1): one event with the batch's summed usage. */
  'openai.batches',
  /** A finished async video task (card 30.6). */
  'openai.videos',
  /** `/v1/rerank` and `/v2/rerank`, Cohere and Jina compatible (card 30.2). */
  'rerank',
  /** One model response of a Realtime WebSocket session (card 30.5). */
  'openai.realtime',
  /** Legacy `/v1/completions` and `/v1/audio/translations` (card 30.4). */
  'openai.completions',
  'openai.translations',
]);
export type InboundApi = z.infer<typeof InboundApi>;

/** What a non-text request consumed (card 21.1), priced by the model's per-unit prices. */
export const MediaUsage = z.object({
  images: z.int().nonnegative().optional(),
  /** Input characters of a speech request. */
  characters: z.int().nonnegative().optional(),
  /** Seconds of audio transcribed, or of video generated (card 30.6); fractional. */
  seconds: z.number().nonnegative().optional(),
  /** Requests priced per request, such as one generated video (card 30.6). */
  requests: z.int().nonnegative().optional(),
  /** Rerank search units (card 30.2): one query over up to 100 documents, as Cohere bills. */
  searches: z.int().nonnegative().optional(),
  /**
   * Realtime audio tokens (card 30.5), priced at the model's audio token rates. The event's
   * `usage` then holds the text (and image) tokens only. Input includes the cached audio tokens.
   */
  audioInputTokens: z.int().nonnegative().optional(),
  audioCachedTokens: z.int().nonnegative().optional(),
  audioOutputTokens: z.int().nonnegative().optional(),
  /** The audio and text shares of the event's `costUsd` (realtime, card 30.5). */
  audioCostUsd: UsdAmount.optional(),
  textCostUsd: UsdAmount.optional(),
  /** The Realtime session this response belongs to (card 30.5). */
  sessionId: z.string().max(128).optional(),
});
export type MediaUsage = z.infer<typeof MediaUsage>;

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
  /** Provider service tier (card 31.5): OpenAI's `service_tier`. */
  serviceTier: z.enum(['auto', 'default', 'flex', 'priority', 'scale']).optional(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  /** Provider-specific parameters that have no generic translation and pass through unchanged. */
  passthrough: JsonObject.optional(),
  /**
   * Fields of the provider's own request body, set by a model's parameter policy (card 31.4) and
   * applied by the outbound translator last: `set` always, `defaults` only where the body has no
   * value, `drop` removed. Names are top-level keys or dotted paths (`generationConfig.topK`).
   */
  upstreamFields: z
    .object({
      set: JsonObject.optional(),
      defaults: JsonObject.optional(),
      drop: z.array(z.string()).optional(),
    })
    .optional(),
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
  /** The service tier the provider actually used, when it says (card 31.5). */
  serviceTier: z.string().optional(),
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
