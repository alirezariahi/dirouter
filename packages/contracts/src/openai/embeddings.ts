/**
 * OpenAI-compatible embeddings (`POST /v1/embeddings`, card 11.4).
 */
import { z } from 'zod';

import { NonNegativeInt } from '../common.js';

export const EmbeddingsRequest = z.looseObject({
  model: z.string(),
  input: z.union([
    z.string(),
    z.array(z.string()).min(1).max(2_048),
    z.array(z.int().nonnegative()).min(1),
    z.array(z.array(z.int().nonnegative())).min(1),
  ]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.int().positive().optional(),
  user: z.string().optional(),
});
export type EmbeddingsRequest = z.infer<typeof EmbeddingsRequest>;

/** Normalized embeddings input: a batch of texts or token arrays. */
export type EmbeddingsInput =
  { kind: 'text'; texts: string[] } | { kind: 'tokens'; batches: number[][] };

export const EmbeddingUsage = z.object({
  prompt_tokens: NonNegativeInt,
  total_tokens: NonNegativeInt,
});
export type EmbeddingUsage = z.infer<typeof EmbeddingUsage>;

export const EmbeddingItem = z.object({
  object: z.literal('embedding'),
  index: z.int(),
  embedding: z.array(z.number()),
});

export const EmbeddingsResponse = z.object({
  object: z.literal('list'),
  data: z.array(EmbeddingItem),
  model: z.string(),
  usage: EmbeddingUsage,
});
export type EmbeddingsResponse = z.infer<typeof EmbeddingsResponse>;
