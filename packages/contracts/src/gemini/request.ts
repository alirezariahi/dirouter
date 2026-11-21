/**
 * Gemini inbound request schemas (`POST /v1beta/models/{model}:generateContent` and
 * `:streamGenerateContent?alt=sse`), so Gemini-native clients (Gemini CLI, Google SDKs) can talk
 * to DiRouter directly (card 11.1).
 *
 * Only fields the gateway translates are typed; unknown fields are preserved (looseObject) so
 * generation parameters that have no canonical equivalent can still pass through.
 */
import { z } from 'zod';

import { JsonObject, NonNegativeInt } from '../common.js';

export const GeminiRequestPart = z.looseObject({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  thoughtSignature: z.string().optional(),
  inlineData: z.looseObject({ mimeType: z.string(), data: z.string() }).optional(),
  fileData: z.looseObject({ mimeType: z.string().optional(), fileUri: z.string() }).optional(),
  functionCall: z
    .looseObject({
      id: z.string().optional(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  functionResponse: z
    .looseObject({
      id: z.string().optional(),
      name: z.string(),
      response: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  executableCode: z
    .looseObject({ language: z.string().optional(), code: z.string().optional() })
    .optional(),
  codeExecutionResult: z
    .looseObject({ outcome: z.string().optional(), output: z.string().optional() })
    .optional(),
});
export type GeminiRequestPart = z.infer<typeof GeminiRequestPart>;

export const GeminiContent = z.looseObject({
  role: z.string().optional(),
  parts: z.array(GeminiRequestPart).default([]),
});
export type GeminiContent = z.infer<typeof GeminiContent>;

export const GeminiGenerationConfig = z.looseObject({
  maxOutputTokens: NonNegativeInt.optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.int().optional(),
  stopSequences: z.array(z.string()).optional(),
  candidateCount: z.int().optional(),
  responseMimeType: z.string().optional(),
  responseSchema: JsonObject.optional(),
  /** JSON Schema alternative to `responseSchema` sent by newer SDKs. */
  responseJsonSchema: JsonObject.optional(),
  thinkingConfig: z
    .looseObject({
      /** `-1` asks for a dynamic budget. */
      thinkingBudget: z.int().optional(),
      thinkingLevel: z.string().optional(),
      includeThoughts: z.boolean().optional(),
    })
    .optional(),
});
export type GeminiGenerationConfig = z.infer<typeof GeminiGenerationConfig>;

export const GeminiToolConfig = z.looseObject({
  functionCallingConfig: z
    .looseObject({
      mode: z.enum(['MODE_UNSPECIFIED', 'AUTO', 'ANY', 'NONE', 'VALIDATED']).optional(),
      allowedFunctionNames: z.array(z.string()).optional(),
    })
    .optional(),
});
export type GeminiToolConfig = z.infer<typeof GeminiToolConfig>;

export const GeminiGenerateContentRequest = z.looseObject({
  contents: z.array(GeminiContent),
  systemInstruction: z
    .looseObject({ role: z.string().optional(), parts: z.array(GeminiRequestPart) })
    .optional(),
  generationConfig: GeminiGenerationConfig.optional(),
  tools: z
    .array(
      z.looseObject({
        functionDeclarations: z
          .array(
            z.looseObject({
              name: z.string(),
              description: z.string().optional(),
              /** Gemini `Schema` object (OpenAPI subset, upper-case type names). */
              parameters: JsonObject.optional(),
              /** Plain JSON Schema; mutually exclusive with `parameters`. */
              parametersJsonSchema: JsonObject.optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  toolConfig: GeminiToolConfig.optional(),
  safetySettings: z
    .array(z.looseObject({ category: z.string(), threshold: z.string() }))
    .optional(),
  cachedContent: z.string().optional(),
  /** Set by the gateway from the `:streamGenerateContent` URL action. */
  stream: z.boolean().optional(),
});
export type GeminiGenerateContentRequest = z.infer<typeof GeminiGenerateContentRequest>;

/** `POST /v1beta/models/{model}:embedContent` (card 11.4). */
export const GeminiEmbedContentRequest = z.looseObject({
  content: z.looseObject({ role: z.string().optional(), parts: z.array(GeminiRequestPart) }),
  taskType: z.string().optional(),
  outputDimensionality: z.int().positive().optional(),
});
export type GeminiEmbedContentRequest = z.infer<typeof GeminiEmbedContentRequest>;

export const GeminiBatchEmbedContentsRequest = z.looseObject({
  requests: z.array(GeminiEmbedContentRequest),
});
export type GeminiBatchEmbedContentsRequest = z.infer<typeof GeminiBatchEmbedContentsRequest>;

export const GeminiEmbedding = z.looseObject({ values: z.array(z.number()) });
export type GeminiEmbedding = z.infer<typeof GeminiEmbedding>;

export const GeminiEmbedContentResponse = z.looseObject({
  embedding: GeminiEmbedding.optional(),
  usageMetadata: z.looseObject({ promptTokenCount: NonNegativeInt.optional() }).optional(),
});
export type GeminiEmbedContentResponse = z.infer<typeof GeminiEmbedContentResponse>;

export const GeminiBatchEmbedContentsResponse = z.looseObject({
  embeddings: z.array(GeminiEmbedding).optional(),
});
export type GeminiBatchEmbedContentsResponse = z.infer<typeof GeminiBatchEmbedContentsResponse>;
