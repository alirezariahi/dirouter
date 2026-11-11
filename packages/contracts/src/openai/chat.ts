/**
 * OpenAI Chat Completions schema (`POST /v1/chat/completions`).
 *
 * The schemas are intentionally "loose": unknown fields are not stripped, so new
 * OpenAI parameters reach the provider without a gateway change.
 */
import { z } from 'zod';

import { JsonObject, NonNegativeInt } from '../common.js';

// ───────────── Content parts ─────────────

export const OpenAITextPart = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

export const OpenAIImagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.looseObject({
    url: z.string(),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
});

export const OpenAIAudioPart = z.looseObject({
  type: z.literal('input_audio'),
  input_audio: z.looseObject({
    data: z.string(),
    format: z.string(),
  }),
});

export const OpenAIFilePart = z.looseObject({
  type: z.literal('file'),
  file: z.looseObject({
    file_id: z.string().optional(),
    file_data: z.string().optional(),
    filename: z.string().optional(),
  }),
});

export const OpenAIRefusalPart = z.looseObject({
  type: z.literal('refusal'),
  refusal: z.string(),
});

export const OpenAIUserContentPart = z.discriminatedUnion('type', [
  OpenAITextPart,
  OpenAIImagePart,
  OpenAIAudioPart,
  OpenAIFilePart,
]);
export type OpenAIUserContentPart = z.infer<typeof OpenAIUserContentPart>;

// ───────────── Tool calls ─────────────

export const OpenAIToolCall = z.looseObject({
  id: z.string(),
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string(),
    /** Arguments as a JSON string (may not be valid JSON). */
    arguments: z.string(),
  }),
});
export type OpenAIToolCall = z.infer<typeof OpenAIToolCall>;

export const OpenAITool = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    parameters: JsonObject.optional(),
    strict: z.boolean().nullish(),
  }),
});
export type OpenAITool = z.infer<typeof OpenAITool>;

export const OpenAIToolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.looseObject({
    type: z.literal('function'),
    function: z.looseObject({ name: z.string() }),
  }),
]);
export type OpenAIToolChoice = z.infer<typeof OpenAIToolChoice>;

// ───────────── Messages ─────────────

const textOrTextParts = z.union([z.string(), z.array(OpenAITextPart)]);

export const OpenAISystemMessage = z.looseObject({
  role: z.literal('system'),
  content: textOrTextParts,
  name: z.string().optional(),
});

export const OpenAIDeveloperMessage = z.looseObject({
  role: z.literal('developer'),
  content: textOrTextParts,
  name: z.string().optional(),
});

export const OpenAIUserMessage = z.looseObject({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(OpenAIUserContentPart)]),
  name: z.string().optional(),
});

export const OpenAIAssistantMessage = z.looseObject({
  role: z.literal('assistant'),
  content: z
    .union([z.string(), z.array(z.discriminatedUnion('type', [OpenAITextPart, OpenAIRefusalPart]))])
    .nullish(),
  refusal: z.string().nullish(),
  name: z.string().optional(),
  tool_calls: z.array(OpenAIToolCall).optional(),
});

export const OpenAIToolMessage = z.looseObject({
  role: z.literal('tool'),
  content: textOrTextParts,
  tool_call_id: z.string(),
});

export const OpenAIChatMessage = z.discriminatedUnion('role', [
  OpenAISystemMessage,
  OpenAIDeveloperMessage,
  OpenAIUserMessage,
  OpenAIAssistantMessage,
  OpenAIToolMessage,
]);
export type OpenAIChatMessage = z.infer<typeof OpenAIChatMessage>;

// ───────────── Request ─────────────

export const OpenAIResponseFormat = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text') }),
  z.looseObject({ type: z.literal('json_object') }),
  z.looseObject({
    type: z.literal('json_schema'),
    json_schema: z.looseObject({
      name: z.string(),
      description: z.string().optional(),
      schema: JsonObject.optional(),
      strict: z.boolean().nullish(),
    }),
  }),
]);

export const OpenAIChatCompletionRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(OpenAIChatMessage).min(1),
  stream: z.boolean().nullish(),
  stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
  max_tokens: NonNegativeInt.nullish(),
  max_completion_tokens: NonNegativeInt.nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  n: z.int().min(1).nullish(),
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
  presence_penalty: z.number().min(-2).max(2).nullish(),
  frequency_penalty: z.number().min(-2).max(2).nullish(),
  logit_bias: z.record(z.string(), z.number()).nullish(),
  logprobs: z.boolean().nullish(),
  top_logprobs: z.int().min(0).max(20).nullish(),
  seed: z.int().nullish(),
  user: z.string().optional(),
  tools: z.array(OpenAITool).optional(),
  tool_choice: OpenAIToolChoice.optional(),
  parallel_tool_calls: z.boolean().optional(),
  response_format: OpenAIResponseFormat.optional(),
  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  store: z.boolean().nullish(),
  service_tier: z.string().nullish(),
});
export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequest>;

// ───────────── Response ─────────────

export const OpenAIFinishReason = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call',
]);
export type OpenAIFinishReason = z.infer<typeof OpenAIFinishReason>;

export const OpenAIUsage = z.looseObject({
  prompt_tokens: NonNegativeInt,
  completion_tokens: NonNegativeInt,
  total_tokens: NonNegativeInt,
  prompt_tokens_details: z
    .looseObject({
      cached_tokens: NonNegativeInt.optional(),
      audio_tokens: NonNegativeInt.optional(),
    })
    .nullish(),
  completion_tokens_details: z
    .looseObject({
      reasoning_tokens: NonNegativeInt.optional(),
      audio_tokens: NonNegativeInt.optional(),
      accepted_prediction_tokens: NonNegativeInt.optional(),
      rejected_prediction_tokens: NonNegativeInt.optional(),
    })
    .nullish(),
});
export type OpenAIUsage = z.infer<typeof OpenAIUsage>;

export const OpenAIChatCompletionResponse = z.looseObject({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.int(),
  model: z.string(),
  choices: z.array(
    z.looseObject({
      index: z.int(),
      message: z.looseObject({
        role: z.literal('assistant'),
        content: z.string().nullable(),
        refusal: z.string().nullish(),
        tool_calls: z.array(OpenAIToolCall).optional(),
      }),
      finish_reason: OpenAIFinishReason.nullable(),
      logprobs: z.unknown().nullish(),
    }),
  ),
  usage: OpenAIUsage.optional(),
  system_fingerprint: z.string().nullish(),
  service_tier: z.string().nullish(),
});
export type OpenAIChatCompletionResponse = z.infer<typeof OpenAIChatCompletionResponse>;

// ───────────── Stream chunk ─────────────

export const OpenAIToolCallDelta = z.looseObject({
  index: z.int(),
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z
    .looseObject({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

export const OpenAIChatCompletionChunk = z.looseObject({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.int(),
  model: z.string(),
  choices: z.array(
    z.looseObject({
      index: z.int(),
      delta: z.looseObject({
        role: z.literal('assistant').optional(),
        content: z.string().nullish(),
        refusal: z.string().nullish(),
        tool_calls: z.array(OpenAIToolCallDelta).optional(),
      }),
      finish_reason: OpenAIFinishReason.nullable(),
      logprobs: z.unknown().nullish(),
    }),
  ),
  /** Only in the last chunk, when `stream_options.include_usage` is enabled. */
  usage: OpenAIUsage.nullish(),
  system_fingerprint: z.string().nullish(),
  service_tier: z.string().nullish(),
});
export type OpenAIChatCompletionChunk = z.infer<typeof OpenAIChatCompletionChunk>;
