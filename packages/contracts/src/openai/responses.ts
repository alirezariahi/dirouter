/**
 * OpenAI Responses API (`POST /v1/responses`, card 11.2).
 *
 * Inbound: a Responses API request is translated to canonical and the answer is encoded back in
 * Responses format (JSON or SSE events). Outbound: providers that only speak Chat Completions are
 * reached through the existing canonical path, so no new provider adapter is required.
 */
import { z } from 'zod';

import { JsonObject, NonNegativeInt } from '../common.js';

/**
 * A content part of a message item. Clients send `input_text` / `input_image` for user turns and
 * replay `output_text` / `refusal` parts for earlier assistant turns; part types the gateway does
 * not translate are accepted here and reported as dropped by the translator.
 */
export const ResponsesContentPart = z.looseObject({
  type: z.string(),
  text: z.string().nullish(),
  refusal: z.string().nullish(),
  image_url: z.string().nullish(),
  detail: z.string().nullish(),
});
export type ResponsesContentPart = z.infer<typeof ResponsesContentPart>;

/** @deprecated kept for callers that validate a single part; use `ResponsesContentPart`. */
export const ResponsesInputText = z.looseObject({
  type: z.literal('input_text'),
  text: z.string(),
});

/** @deprecated kept for callers that validate a single part; use `ResponsesContentPart`. */
export const ResponsesInputImage = z.looseObject({
  type: z.literal('input_image'),
  image_url: z.string().nullish(),
  detail: z.string().nullish(),
});

/**
 * One input item. The schema is deliberately lenient: only the fields the translator reads are
 * typed, and item types it does not know (`web_search_call`, `local_shell_call`,
 * `custom_tool_call`, …) pass validation so the translator can skip them instead of the whole
 * request failing with a 400.
 */
export const ResponsesInputItem = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  /** Shorthand form: `content` is a string or an array of parts. */
  content: z.union([z.string(), z.array(ResponsesContentPart)]).nullish(),
  /** Function call / function call output items. */
  call_id: z.string().nullish(),
  /** A string, or an array of `input_text` / `input_image` parts; other item types use objects. */
  output: z.unknown().optional(),
  name: z.string().nullish(),
  /** A JSON string for `function_call`; other item types may carry other shapes. */
  arguments: z.unknown().optional(),
  id: z.string().nullish(),
  tool_call_id: z.string().nullish(),
  /** Reasoning output item replayed in the next turn (summary text). */
  summary: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        text: z.string().nullish(),
      }),
    )
    .nullish(),
  encrypted_content: z.string().nullish(),
});
export type ResponsesInputItem = z.infer<typeof ResponsesInputItem>;

/**
 * Responses tools are flat (`{type:'function', name, parameters, …}`), unlike Chat Completions.
 * The nested Chat form is still accepted for clients that send it by mistake. Built-in and custom
 * tool types (`web_search`, `local_shell`, `custom`, …) validate and are dropped by the translator.
 */
export const ResponsesTool = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  description: z.string().nullish(),
  parameters: JsonObject.nullish(),
  strict: z.boolean().nullish(),
  function: z
    .looseObject({
      name: z.string(),
      description: z.string().nullish(),
      parameters: JsonObject.nullish(),
      strict: z.boolean().nullish(),
    })
    .optional(),
});
export type ResponsesTool = z.infer<typeof ResponsesTool>;

export const ResponsesReasoningEffort = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ResponsesReasoningEffort = z.infer<typeof ResponsesReasoningEffort>;

export const ResponsesRequest = z.looseObject({
  model: z.string(),
  input: z.union([z.string(), z.array(ResponsesInputItem)]),
  instructions: z.string().nullish(),
  max_output_tokens: NonNegativeInt.nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  stream: z.boolean().nullish(),
  tools: z.array(ResponsesTool).nullish(),
  tool_choice: z
    .union([
      z.enum(['auto', 'none', 'required']),
      /** `{type:'function', name}`; other object forms (allowed_tools, built-ins) are dropped. */
      z.looseObject({ type: z.string(), name: z.string().optional() }),
    ])
    .nullish(),
  parallel_tool_calls: z.boolean().nullish(),
  text: z
    .looseObject({
      format: z
        .looseObject({
          type: z.string(),
          name: z.string().optional(),
          schema: JsonObject.optional(),
          strict: z.boolean().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  reasoning: z.looseObject({ effort: ResponsesReasoningEffort.nullish() }).nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
  user: z.string().nullish(),
  previous_response_id: z.string().nullish(),
});
export type ResponsesRequest = z.infer<typeof ResponsesRequest>;

export const ResponsesUsage = z.looseObject({
  input_tokens: NonNegativeInt,
  output_tokens: NonNegativeInt,
  total_tokens: NonNegativeInt,
  input_tokens_details: z.looseObject({ cached_tokens: NonNegativeInt.optional() }).optional(),
  output_tokens_details: z.looseObject({ reasoning_tokens: NonNegativeInt.optional() }).optional(),
});
export type ResponsesUsage = z.infer<typeof ResponsesUsage>;
