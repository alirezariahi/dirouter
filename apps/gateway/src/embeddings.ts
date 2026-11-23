/**
 * `/v1/embeddings` (card 11.4): OpenAI-compatible embeddings through the routing and fallback
 * pipeline. Gemini's `:embedContent` reuses the same core and only changes the response shape.
 */
import type { EmbeddingsRequest } from '@dirouter/contracts';
import { adapterFor, type EmbeddingsResult, maxEmbeddingBatch } from '@dirouter/providers';
import type { Candidate } from '@dirouter/routing';
import { DiRouterError, ValidationError } from '@dirouter/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { runMetered } from './metered.js';
import type { ProxyDeps } from './proxy.js';

interface EmbedOutcome {
  vectors: number[][];
  usage: { inputTokens: number };
  candidate: Candidate;
  estimated: boolean;
}

type EmbedResult =
  | { ok: true; value: EmbedOutcome; headers?: Record<string, string> }
  | { ok: false; error: DiRouterError; headers?: Record<string, string> };

function parseTexts(body: EmbeddingsRequest): string[] {
  if (typeof body.input === 'string') return [body.input];
  if (body.input.every((x): x is string => typeof x === 'string')) return body.input;
  throw new ValidationError([
    {
      path: 'input',
      message: 'token-array embeddings input is not supported; send text or an array of texts',
    },
  ]);
}

async function embed(
  req: FastifyRequest,
  deps: ProxyDeps,
  input: { model: string; texts: string[]; dimensions?: number },
): Promise<EmbedResult> {
  const estimatedInputTokens = input.texts.reduce(
    (sum, text) => sum + Math.ceil(text.length / 4),
    0,
  );
  const result = await runMetered<EmbeddingsResult>(req, deps, {
    inboundApi: 'openai.embeddings',
    model: input.model,
    estimatedInputTokens,
    worstCase: { usage: { inputTokens: estimatedInputTokens }, estimated: true },
    // Each provider caps the number of inputs per call. Targets that cannot take this batch are
    // skipped; when none can, the client gets a clear 400 instead of an upstream error.
    select: (candidates) => {
      const fits = candidates.filter(
        (c) => input.texts.length <= maxEmbeddingBatch(c.provider, c.model.upstreamModel),
      );
      if (fits.length > 0) return fits;
      const largest = Math.max(
        ...candidates.map((c) => maxEmbeddingBatch(c.provider, c.model.upstreamModel)),
      );
      return new DiRouterError('invalid_request', {
        message: `too many inputs (${String(input.texts.length)}); '${input.model}' accepts at most ${String(largest)} per request`,
        param: 'input',
        status: 400,
      });
    },
    build: (candidate, apiKey) =>
      adapterFor(candidate.provider.type).buildEmbeddingsRequest?.({
        provider: candidate.provider,
        model: candidate.model,
        apiKey,
        texts: input.texts,
        ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
        encodingFormat: 'float',
        credentialHeaders: candidate.credential.headers,
      }),
    read: async (response, candidate) => {
      const adapter = adapterFor(candidate.provider.type);
      if (!adapter.parseEmbeddingsResponse) throw new Error('embeddings not supported');
      return adapter.parseEmbeddingsResponse(await response.json());
    },
    meter: (value) => ({
      usage: { inputTokens: value.usage?.inputTokens ?? estimatedInputTokens },
      estimated: value.usage === undefined,
    }),
  });
  if (!result.ok) return result;
  return {
    ok: true,
    ...(result.headers ? { headers: result.headers } : {}),
    value: {
      vectors: result.value.vectors,
      usage: { inputTokens: result.metering.usage.inputTokens ?? 0 },
      candidate: result.candidate,
      estimated: result.metering.estimated,
    },
  };
}

/** OpenAI's base64 embedding format: little-endian float32 values, base64-encoded. */
export function encodeEmbeddingBase64(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString('base64');
}

export async function handleEmbeddings(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  let body: EmbeddingsRequest;
  let texts: string[];
  try {
    // The body is client input: nothing about its shape is known until it is checked.
    const parsed = (req.body ?? {}) as Partial<EmbeddingsRequest>;
    if (typeof parsed.model !== 'string' || parsed.input === undefined)
      throw new ValidationError([{ path: 'model', message: 'model and input are required' }]);
    body = parsed as EmbeddingsRequest;
    texts = parseTexts(body);
  } catch (error) {
    const e = error instanceof DiRouterError ? error : new DiRouterError('invalid_request');
    reply.status(e.status).send(e.toOpenAI());
    return;
  }

  const result = await embed(req, deps, {
    model: body.model,
    texts,
    ...(body.dimensions !== undefined ? { dimensions: body.dimensions } : {}),
  });
  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  if (!result.ok) {
    reply.status(result.error.status).send(result.error.toOpenAI());
    return;
  }
  void reply
    .header('x-dirouter-model', result.value.candidate.model.slug)
    .header('x-dirouter-provider', result.value.candidate.provider.slug);
  // The official OpenAI SDKs ask for base64 by default and decode it client-side. Upstreams are
  // always called with floats (not every provider supports base64), and the gateway encodes.
  const base64 = body.encoding_format === 'base64';
  reply.status(200).send({
    object: 'list',
    data: result.value.vectors.map((embedding, index) => ({
      object: 'embedding',
      index,
      embedding: base64 ? encodeEmbeddingBase64(embedding) : embedding,
    })),
    model: body.model,
    usage: {
      prompt_tokens: result.value.usage.inputTokens,
      total_tokens: result.value.usage.inputTokens,
    },
  });
}

/** Gemini `:embedContent` / `:batchEmbedContents` → Google's response shape, same pipeline. */
export async function handleGeminiEmbeddings(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
): Promise<void> {
  const param = (req.params as { modelAction?: string }).modelAction ?? '';
  const [model = '', action = 'embedContent'] = param.split(':');
  const body = (req.body ?? {}) as {
    content?: { parts?: { text?: string }[] };
    requests?: { content?: { parts?: { text?: string }[] } }[];
  };
  const textOf = (parts?: { text?: string }[]) => (parts ?? []).map((p) => p.text ?? '').join('\n');
  const texts =
    action === 'batchEmbedContents'
      ? (body.requests ?? []).map((r) => textOf(r.content?.parts))
      : [textOf(body.content?.parts)];

  if (texts.length === 0 || texts.every((text) => text === '')) {
    reply.status(400).send({
      error: {
        code: 400,
        message: 'content with text parts is required',
        status: 'INVALID_ARGUMENT',
      },
    });
    return;
  }
  const result = await embed(req, deps, { model, texts });
  for (const [name, value] of Object.entries(result.headers ?? {})) void reply.header(name, value);
  if (!result.ok) {
    const status = result.error.status;
    reply.status(status).send({
      error: {
        code: status,
        message: result.error.message,
        status:
          status === 429
            ? 'RESOURCE_EXHAUSTED'
            : status === 401
              ? 'UNAUTHENTICATED'
              : status === 403
                ? 'PERMISSION_DENIED'
                : status === 404
                  ? 'NOT_FOUND'
                  : status >= 500
                    ? 'UNAVAILABLE'
                    : 'INVALID_ARGUMENT',
      },
    });
    return;
  }
  void reply.header('x-dirouter-model', result.value.candidate.model.slug);
  reply
    .status(200)
    .send(
      action === 'batchEmbedContents'
        ? { embeddings: result.value.vectors.map((values) => ({ values })) }
        : { embedding: { values: result.value.vectors[0] ?? [] } },
    );
}
