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

/** An OpenAI function tool, as the playground lets a user define it (card 25.6). */
const PlaygroundTool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: z.string().max(2_000).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Image as a data URL; the dashboard downsizes it first, the whole body must stay under 1 MB. */
const ImageDataUrl = z
  .string()
  .max(900_000)
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/, 'a base64 image data URL');

/** One streamed playground call (card 25.6): one model, the parameters a client really sends. */
export const PlaygroundStreamBody = z.object({
  apiKey: PlaygroundBody.shape.apiKey,
  model: z.string().min(1).max(200),
  system: PlaygroundBody.shape.system,
  /** Earlier turns of a request replayed from the Log Explorer (card 24.1). */
  history: PlaygroundBody.shape.history,
  prompt: PlaygroundBody.shape.prompt,
  image: ImageDataUrl.optional(),
  tools: z.array(PlaygroundTool).max(32).optional(),
  toolChoice: z.enum(['auto', 'none', 'required']).optional(),
  maxTokens: z.int().min(1).max(32_768).default(512),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  responseFormat: z
    .union([
      z.object({ type: z.enum(['text', 'json_object']) }),
      z.object({
        type: z.literal('json_schema'),
        json_schema: z.object({
          name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          schema: z.record(z.string(), z.unknown()),
          strict: z.boolean().optional(),
        }),
      }),
    ])
    .optional(),
});
export type PlaygroundStreamInput = z.infer<typeof PlaygroundStreamBody>;

/** The OpenAI chat request the gateway receives for a streamed playground call. */
export function streamRequest(input: PlaygroundStreamInput) {
  return {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      ...(input.system ? [{ role: 'system', content: input.system }] : []),
      ...(input.history ?? []),
      {
        role: 'user',
        content: input.image
          ? [
              { type: 'text', text: input.prompt },
              { type: 'image_url', image_url: { url: input.image } },
            ]
          : input.prompt,
      },
    ],
    max_tokens: input.maxTokens,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { top_p: input.topP } : {}),
    ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
    ...(input.responseFormat ? { response_format: input.responseFormat } : {}),
    ...(input.tools?.length ? { tools: input.tools } : {}),
    ...(input.toolChoice && input.tools?.length ? { tool_choice: input.toolChoice } : {}),
  };
}

/** One server-sent event of the playground stream. */
export const sseEvent = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** `x-dirouter-*` and `x-request-id` headers of a gateway answer, for the playground column. */
export function routingHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-dirouter-') || lower === 'x-request-id') out[lower] = value;
  });
  return out;
}
