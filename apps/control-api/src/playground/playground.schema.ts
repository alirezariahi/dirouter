/** Request schema and cost estimate of the playground (card 16.5); free of framework imports. */
import { z } from 'zod';

export const PlaygroundBody = z.object({
  apiKey: z.string().min(10).max(200).describe('a virtual key created by the caller; never stored'),
  models: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(4)
    .refine((models) => new Set(models).size === models.length, 'models must be distinct'),
  system: z.string().max(20_000).optional(),
  /** Earlier turns sent before the prompt, e.g. a request replayed from the Log Explorer (24.1). */
  history: z
    .array(
      z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(50_000) }),
    )
    .max(100)
    .optional(),
  prompt: z.string().min(1).max(50_000),
  maxTokens: z.int().min(1).max(4_096).default(512),
  temperature: z.number().min(0).max(2).optional(),
});

/** Per-million-token prices → cost of one call, as a fixed 8-decimal string. */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: { inputPerMTok: number; outputPerMTok: number },
): string {
  const cost =
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok;
  return cost.toFixed(8);
}

export const PlaygroundResponse = z.object({
  apiKeyId: z.string(),
  results: z.array(
    z.object({
      model: z.string(),
      ok: z.boolean(),
      status: z.int(),
      latencyMs: z.int(),
      text: z.string().optional(),
      resolvedModel: z.string().optional(),
      provider: z.string().optional(),
      cache: z.string().optional(),
      inputTokens: z.int().optional(),
      outputTokens: z.int().optional(),
      estimatedCostUsd: z.string().optional(),
      error: z.object({ code: z.string().optional(), message: z.string() }).optional(),
    }),
  ),
});
