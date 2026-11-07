/**
 * اسکیمای پاسخ Gemini (`generateContent` و هر chunk از `streamGenerateContent?alt=sse`).
 *
 * فقط فیلدهایی که گیت‌وی می‌خواند تعریف شده‌اند؛ بقیه با looseObject حفظ می‌شوند.
 */
import { z } from 'zod';

import { NonNegativeInt } from '../common.js';

export const GeminiPart = z.looseObject({
  text: z.string().optional(),
  /** true یعنی این part خلاصهٔ استدلال (thought) است، نه پاسخ. */
  thought: z.boolean().optional(),
  thoughtSignature: z.string().optional(),
  functionCall: z
    .looseObject({
      id: z.string().optional(),
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  inlineData: z.looseObject({ mimeType: z.string(), data: z.string() }).optional(),
});
export type GeminiPart = z.infer<typeof GeminiPart>;

export const GeminiFinishReason = z.string();

export const GeminiCandidate = z.looseObject({
  content: z
    .looseObject({ role: z.string().optional(), parts: z.array(GeminiPart).optional() })
    .optional(),
  finishReason: GeminiFinishReason.optional(),
  index: z.int().optional(),
});
export type GeminiCandidate = z.infer<typeof GeminiCandidate>;

export const GeminiUsageMetadata = z.looseObject({
  /** شامل cachedContentTokenCount است. */
  promptTokenCount: NonNegativeInt.optional(),
  /** شامل thoughtsTokenCount نیست. */
  candidatesTokenCount: NonNegativeInt.optional(),
  thoughtsTokenCount: NonNegativeInt.optional(),
  cachedContentTokenCount: NonNegativeInt.optional(),
  toolUsePromptTokenCount: NonNegativeInt.optional(),
  totalTokenCount: NonNegativeInt.optional(),
});
export type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadata>;

export const GeminiGenerateContentResponse = z.looseObject({
  candidates: z.array(GeminiCandidate).optional(),
  promptFeedback: z
    .looseObject({ blockReason: z.string().optional(), blockReasonMessage: z.string().optional() })
    .optional(),
  usageMetadata: GeminiUsageMetadata.optional(),
  modelVersion: z.string().optional(),
  responseId: z.string().optional(),
});
export type GeminiGenerateContentResponse = z.infer<typeof GeminiGenerateContentResponse>;
