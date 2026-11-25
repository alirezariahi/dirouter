/**
 * Model comparison playground (card 16.5).
 *
 * The dashboard sends one prompt and a list of models; each model is called through the gateway
 * with a virtual key that the signed-in user created, so the normal pipeline applies: routing,
 * limits, budgets, guardrails, and the usage is billed to that key like any other request.
 * The key is used for the outbound calls only: it is never stored, logged or echoed back.
 *
 * Streaming (card 25.6): `stream` runs one model as a real client would (stream, tools, image,
 * max_tokens, top_p, reasoning effort, response_format) and re-emits the gateway's answer as
 * server-sent events: `meta` (status and x-dirouter-* headers), `ttft` (first token), `chunk`
 * (each OpenAI chunk as is), `error` and `end` (latency, tokens, estimated cost). The dashboard
 * opens one stream per compared model.
 */
import { DiRouterError, hashApiKey } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import {
  estimateCostUsd,
  type PlaygroundStreamInput,
  routingHeaders,
  sseEvent,
  streamRequest,
} from './playground.schema.js';

type Price = { inputPerMTok: number; outputPerMTok: number };

interface StreamChunk {
  choices?: { delta?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface PlaygroundInput {
  apiKey: string;
  models: string[];
  system?: string | undefined;
  /** Earlier turns of a replayed conversation (card 24.1). */
  history?: { role: 'user' | 'assistant'; content: string }[] | undefined;
  prompt: string;
  maxTokens: number;
  temperature?: number | undefined;
}

export interface PlaygroundResult {
  model: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  text?: string;
  resolvedModel?: string;
  provider?: string;
  cache?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Estimate from the model's current price; the ledger holds the authoritative amount. */
  estimatedCostUsd?: string;
  error?: { code?: string; message: string };
}

@Injectable()
export class PlaygroundService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The key must exist, be active, belong to this organization and have been created by the caller. */
  async #ownKey(org: OrgContext, apiKey: string) {
    const key = await this.prisma.client.apiKey.findUnique({
      where: { hash: hashApiKey(apiKey, this.env.KEY_PEPPER) },
      select: {
        id: true,
        organizationId: true,
        createdById: true,
        status: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    const usable =
      key !== null &&
      key.organizationId === org.organizationId &&
      key.status === 'ACTIVE' &&
      key.revokedAt === null &&
      (key.expiresAt === null || key.expiresAt.getTime() > Date.now());
    // One message for every failure: do not reveal whether a key exists in another organization.
    if (!usable)
      throw new DiRouterError('validation_failed', {
        message: 'The virtual key is not valid for this organization',
      });
    if (key.createdById !== org.userId)
      throw new DiRouterError('forbidden', {
        message: 'Use a virtual key that you created; playground usage is billed to that key',
      });
    return key.id;
  }

  async compare(org: OrgContext, input: PlaygroundInput) {
    const apiKeyId = await this.#ownKey(org, input.apiKey);
    const prices = await this.prisma.client.model.findMany({
      where: { organizationId: org.organizationId, slug: { in: input.models }, deletedAt: null },
      select: { slug: true, inputPrice: true, outputPrice: true },
    });
    const priceOf = new Map(
      prices.map((m) => [
        m.slug,
        { inputPerMTok: Number(m.inputPrice), outputPerMTok: Number(m.outputPrice) },
      ]),
    );
    const results = await Promise.all(
      input.models.map((model) => this.#call(model, input, priceOf)),
    );
    return { apiKeyId, results };
  }

  /**
   * Checks the key and loads the price before anything is streamed, so a refused key is still an
   * ordinary JSON error; returns the generator of the events.
   */
  async prepareStream(org: OrgContext, input: PlaygroundStreamInput, signal: AbortSignal) {
    const apiKeyId = await this.#ownKey(org, input.apiKey);
    const row = await this.prisma.client.model.findFirst({
      where: { organizationId: org.organizationId, slug: input.model, deletedAt: null },
      select: { inputPrice: true, outputPrice: true },
    });
    const price = row
      ? { inputPerMTok: Number(row.inputPrice), outputPerMTok: Number(row.outputPrice) }
      : undefined;
    return { apiKeyId, events: this.stream(input, price, signal) };
  }

  async *stream(
    input: PlaygroundStreamInput,
    price: Price | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(
        `${this.env.GATEWAY_INTERNAL_URL.replace(/\/+$/, '')}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            'x-dirouter-client': 'playground',
          },
          body: JSON.stringify(streamRequest(input)),
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        },
      );
    } catch {
      yield sseEvent('error', { status: 0, message: 'the gateway is not reachable' });
      yield sseEvent('end', { latencyMs: Date.now() - started });
      return;
    }
    yield sseEvent('meta', { status: res.status, headers: routingHeaders(res.headers) });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      yield sseEvent('error', {
        status: res.status,
        ...(body.error?.code ? { code: body.error.code } : {}),
        message: body.error?.message ?? `gateway answered ${String(res.status)}`,
      });
      yield sseEvent('end', { latencyMs: Date.now() - started });
      return;
    }
    let ttftMs: number | undefined;
    let usage: StreamChunk['usage'];
    const cached = res.headers.get('x-dirouter-cache') !== null;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data || data === '[DONE]') continue;
          let chunk: StreamChunk & { error?: { code?: string; message?: string } };
          try {
            chunk = JSON.parse(data) as typeof chunk;
          } catch {
            continue;
          }
          if (chunk.error) {
            yield sseEvent('error', {
              status: res.status,
              ...(chunk.error.code ? { code: chunk.error.code } : {}),
              message: chunk.error.message ?? 'stream error',
            });
            continue;
          }
          const delta = chunk.choices?.[0]?.delta;
          if (
            ttftMs === undefined &&
            delta &&
            ((typeof delta.content === 'string' && delta.content !== '') ||
              delta.tool_calls !== undefined ||
              delta.reasoning_content !== undefined)
          ) {
            ttftMs = Date.now() - started;
            yield sseEvent('ttft', { ms: ttftMs });
          }
          if (chunk.usage) usage = chunk.usage;
          yield sseEvent('chunk', chunk);
        }
      }
    } catch {
      if (!signal.aborted) yield sseEvent('error', { status: 0, message: 'the stream broke off' });
    }
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    yield sseEvent('end', {
      latencyMs: Date.now() - started,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      inputTokens,
      outputTokens,
      ...(cached
        ? { estimatedCostUsd: '0.00000000' }
        : price
          ? { estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens, price) }
          : {}),
    });
  }

  async #call(
    model: string,
    input: PlaygroundInput,
    priceOf: Map<string, { inputPerMTok: number; outputPerMTok: number }>,
  ): Promise<PlaygroundResult> {
    const started = Date.now();
    try {
      const res = await fetch(
        `${this.env.GATEWAY_INTERNAL_URL.replace(/\/+$/, '')}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
            'x-dirouter-client': 'playground',
          },
          body: JSON.stringify({
            model,
            messages: [
              ...(input.system ? [{ role: 'system', content: input.system }] : []),
              ...(input.history ?? []),
              { role: 'user', content: input.prompt },
            ],
            max_tokens: input.maxTokens,
            ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );
      const latencyMs = Date.now() - started;
      const body = (await res.json().catch(() => ({}))) as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { code?: string; message?: string };
      };
      if (!res.ok)
        return {
          model,
          ok: false,
          status: res.status,
          latencyMs,
          error: {
            ...(body.error?.code ? { code: body.error.code } : {}),
            message: body.error?.message ?? `gateway answered ${String(res.status)}`,
          },
        };
      const content = body.choices?.[0]?.message?.content;
      const inputTokens = body.usage?.prompt_tokens ?? 0;
      const outputTokens = body.usage?.completion_tokens ?? 0;
      const resolved = res.headers.get('x-dirouter-model') ?? undefined;
      const price = priceOf.get(resolved ?? model) ?? priceOf.get(model);
      const cache = res.headers.get('x-dirouter-cache') ?? undefined;
      const provider = res.headers.get('x-dirouter-provider') ?? undefined;
      return {
        model,
        ok: true,
        status: res.status,
        latencyMs,
        text: typeof content === 'string' ? content : JSON.stringify(content ?? ''),
        ...(resolved ? { resolvedModel: resolved } : {}),
        ...(provider ? { provider } : {}),
        ...(cache ? { cache } : {}),
        inputTokens,
        outputTokens,
        // A cache hit costs nothing; otherwise estimate from the current price list.
        ...(cache
          ? { estimatedCostUsd: '0.00000000' }
          : price
            ? { estimatedCostUsd: estimateCostUsd(inputTokens, outputTokens, price) }
            : {}),
      };
    } catch (error) {
      return {
        model,
        ok: false,
        status: 0,
        latencyMs: Date.now() - started,
        error: {
          message:
            error instanceof Error && error.name === 'TimeoutError'
              ? 'the gateway did not answer within 120 seconds'
              : 'the gateway is not reachable',
        },
      };
    }
  }
}
