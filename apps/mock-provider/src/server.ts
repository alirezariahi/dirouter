/**
 * Fake provider compatible with OpenAI, Anthropic and Gemini, with error injection (cards 9.1 and 4.8).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import {
  classifierAnswer,
  moderationScores,
  DEFAULT_SCENARIO,
  directivesFromKey,
  parseScenario,
  sampleLatency,
  type Scenario,
} from './scenario.js';
import { registerA2a } from './a2a.js';
import { promptCache, registerBedrock } from './bedrock.js';
import {
  STRUCTURED_OUTPUT_TOOL,
  anthropicFallbackSchema,
  anthropicNativeSchema,
  sampleFor,
} from './structured.js';
import { registerMcp } from './mcp.js';
import { registerBatches } from './batches.js';
import { registerMedia, registerWorkersAi } from './media.js';
import { registerCatalog } from './catalog.js';
import { newRealtimeStats, type RealtimeStats, registerRealtime } from './realtime.js';
import { registerOAuth } from './oauth.js';
import { type PaymentMockOptions, registerPayments } from './payments.js';

type Api = 'openai' | 'anthropic' | 'gemini';

interface Stats {
  requests: number;
  byKey: Record<string, number>;
  byStatus: Record<string, number>;
  /** Last received bodies (for assertions in e2e tests). */
  last: unknown[];
  /** Last `traceparent` headers received (card 17.2). */
  traceparents: string[];
  /** Currently open requests and their peak (for bulkhead tests). */
  inFlight: number;
  maxInFlight: number;
  /** Realtime WebSocket sessions (card 30.5). */
  realtime: RealtimeStats;
}

const newStats = (): Stats => ({
  requests: 0,
  byKey: {},
  byStatus: {},
  last: [],
  traceparents: [],
  inFlight: 0,
  maxInFlight: 0,
  realtime: newRealtimeStats(),
});

/** Simple estimate: every 4 characters is one token. */
const tokens = (value: unknown) => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4));

const GOOGLE_STATUS: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  529: 'UNAVAILABLE',
};

function errorBody(api: Api, status: number, message: string, type: string) {
  if (api === 'gemini')
    return { error: { code: status, message, status: GOOGLE_STATUS[status] ?? 'INTERNAL' } };
  return api === 'openai'
    ? { error: { message, type, param: null, code: type } }
    : { type: 'error', error: { type, message } };
}

const ERROR_TYPES: Record<number, { openai: string; anthropic: string; message: string }> = {
  400: {
    openai: 'invalid_request_error',
    anthropic: 'invalid_request_error',
    message: 'Bad request',
  },
  401: { openai: 'invalid_api_key', anthropic: 'authentication_error', message: 'Invalid API key' },
  403: { openai: 'permission_error', anthropic: 'permission_error', message: 'Forbidden' },
  404: { openai: 'model_not_found', anthropic: 'not_found_error', message: 'Model not found' },
  429: {
    openai: 'rate_limit_exceeded',
    anthropic: 'rate_limit_error',
    message: 'Rate limit reached',
  },
  500: { openai: 'server_error', anthropic: 'api_error', message: 'Internal server error' },
  502: { openai: 'server_error', anthropic: 'api_error', message: 'Bad gateway' },
  503: { openai: 'server_error', anthropic: 'api_error', message: 'Service unavailable' },
  529: { openai: 'server_error', anthropic: 'overloaded_error', message: 'Overloaded' },
};

export interface MockServerOptions {
  defaultDirectives?: string;
  /** Fake Zarinpal and Stripe (card 19.2). */
  payments?: PaymentMockOptions;
}

export function buildServer(options: MockServerOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  let defaults = parseScenario(options.defaultDirectives, DEFAULT_SCENARIO);
  let stats = newStats();

  // Mock OAuth token endpoints (card 27.4); registered first so its token check runs early.
  registerOAuth(app);

  app.addHook('onRequest', (req, reply, done) => {
    if (req.url.startsWith('/__mock') || req.url === '/healthz') {
      done();
      return;
    }
    const counted = stats;
    counted.inFlight++;
    counted.maxInFlight = Math.max(counted.maxInFlight, counted.inFlight);
    reply.raw.once('close', () => {
      counted.inFlight--;
    });
    done();
  });

  function scenarioFor(req: Pick<FastifyRequest, 'headers'>): Scenario {
    const header = req.headers['x-mock'];
    const fromHeader = typeof header === 'string' ? header : undefined;
    const keyHeader =
      req.headers['x-api-key'] ??
      req.headers.authorization ??
      req.headers['api-key'] ??
      req.headers['x-goog-api-key'];
    const fromKey = directivesFromKey(typeof keyHeader === 'string' ? keyHeader : undefined);
    return parseScenario([fromKey, fromHeader].filter(Boolean).join(','), defaults);
  }

  function record(req: FastifyRequest, status: number) {
    const key = String(
      req.headers['x-api-key'] ??
        req.headers.authorization ??
        req.headers['api-key'] ??
        req.headers['x-goog-api-key'] ??
        'none',
    );
    stats.requests++;
    stats.byKey[key] = (stats.byKey[key] ?? 0) + 1;
    stats.byStatus[String(status)] = (stats.byStatus[String(status)] ?? 0) + 1;
    stats.last.push(req.body);
    if (stats.last.length > 20) stats.last.shift();
    // Trace context received from the gateway (card 17.2), so tests can follow a trace upstream.
    const traceparent = req.headers.traceparent;
    if (typeof traceparent === 'string') {
      stats.traceparents.push(traceparent);
      if (stats.traceparents.length > 20) stats.traceparents.shift();
    }
  }

  /** Fixed or random error; returns true if an error was sent. */
  async function maybeFail(
    api: Api,
    s: Scenario,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<boolean> {
    let status = s.status;
    if (status === undefined && s.contextLength) status = 400;
    if (status === undefined && s.errorRate > 0 && Math.random() < s.errorRate) status = 503;
    if (status === undefined || status < 400) return false;
    record(req, status);
    const spec = ERROR_TYPES[status] ?? {
      openai: 'server_error',
      anthropic: 'api_error',
      message: 'Internal server error',
    };
    const message = !s.contextLength
      ? spec.message
      : api === 'gemini'
        ? 'The input token count (9001) exceeds the maximum number of tokens allowed (8192).'
        : "This model's maximum context length is 8192 tokens. However, your messages resulted in 9001 tokens.";
    const type =
      s.contextLength && api === 'openai'
        ? 'context_length_exceeded'
        : spec[api === 'gemini' ? 'openai' : api];
    if (s.retryAfter !== undefined) void reply.header('retry-after', String(s.retryAfter));
    await reply.status(status).send(errorBody(api, status, message, type));
    return true;
  }

  function chunksOf(text: string, n: number): string[] {
    const size = Math.max(1, Math.ceil(text.length / n));
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  // ───────────── OpenAI ─────────────

  async function openai(req: FastifyRequest, reply: FastifyReply, model: string) {
    const s = scenarioFor(req);
    await sleep(sampleLatency(s.latency));
    if (await maybeFail('openai', s, req, reply)) return;
    const body = (req.body ?? {}) as {
      messages?: unknown;
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    // Classifier models used by guardrails (cards 23.2 and 23.3) answer deterministically.
    const verdict = classifierAnswer(model, body.messages);
    if (verdict !== undefined) s.text = verdict;
    const promptTokens = tokens(body.messages);
    const id = `chatcmpl-mock${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const pieces = chunksOf(s.text, s.chunks);
    const completionTokens = s.tool ? 12 : pieces.length * 2;
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
    const toolCall = s.tool
      ? {
          id: 'call_mock1',
          type: 'function',
          function: { name: s.tool, arguments: '{"city":"Tehran"}' },
        }
      : undefined;

    if (!body.stream) {
      record(req, 200);
      await sleep(s.ttftMs);
      return reply.send({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: toolCall ? null : s.text,
              ...(toolCall ? { tool_calls: [toolCall] } : {}),
            },
            finish_reason: toolCall ? 'tool_calls' : 'stop',
            logprobs: null,
          },
        ],
        ...(s.noUsage ? {} : { usage }),
      });
    }

    record(req, 200);
    await sleep(s.ttftMs);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    const chunk = (delta: unknown, finish: string | null = null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });
    let sent = 0;
    const drop = () => s.dropAfter !== undefined && sent >= s.dropAfter;

    send(chunk({ role: 'assistant', content: '' }));
    if (toolCall) {
      send(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: toolCall.id,
              type: 'function',
              function: { name: toolCall.function.name, arguments: '' },
            },
          ],
        }),
      );
      for (const part of ['{"city":', '"Tehran"}']) {
        if (drop()) return res.destroy();
        await sleep(s.chunkDelayMs);
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }));
        sent++;
      }
    } else {
      for (const piece of pieces) {
        if (drop()) return res.destroy();
        await sleep(s.chunkDelayMs);
        if (res.destroyed) return;
        send(chunk({ content: piece }));
        sent++;
      }
    }
    if (drop()) return res.destroy();
    send(chunk({}, toolCall ? 'tool_calls' : 'stop'));
    if (body.stream_options?.include_usage && !s.noUsage)
      send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    res.end('data: [DONE]\n\n');
  }

  app.post('/v1/chat/completions', (req, reply) =>
    openai(req, reply, (req.body as { model?: string } | undefined)?.model ?? 'mock'),
  );

  // ───────────── Moderation (card 23.2) ─────────────
  app.post('/v1/moderations', async (req, reply) => {
    const s = scenarioFor(req);
    await sleep(sampleLatency(s.latency));
    if (await maybeFail('openai', s, req, reply)) return;
    const body = (req.body ?? {}) as { model?: string; input?: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    record(req, 200);
    return reply.send({
      id: `modr-mock${Date.now().toString(36)}`,
      model: body.model ?? 'omni-moderation-latest',
      results: inputs.map((text) => {
        const scores = moderationScores(text);
        const categories = Object.fromEntries(
          Object.entries(scores).map(([name, score]) => [name, score >= 0.5]),
        );
        return {
          flagged: Object.values(categories).some(Boolean),
          categories,
          category_scores: scores,
        };
      }),
    });
  });

  // ───────────── Embeddings (card 11.4) ─────────────
  const embedding = (text: string, dimensions: number) =>
    Array.from({ length: dimensions }, (_, i) => ((text.length + i) % 10) / 10);

  app.post('/v1/embeddings', async (req, reply) => {
    const s = scenarioFor(req);
    await sleep(sampleLatency(s.latency));
    if (await maybeFail('openai', s, req, reply)) return;
    const body = (req.body ?? {}) as {
      input?: string | string[];
      dimensions?: number;
      encoding_format?: string;
    };
    if (body.encoding_format === 'base64')
      return reply
        .status(400)
        .send(errorBody('openai', 400, 'base64 is not supported here', 'invalid_request'));
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    // Like the real model, `text-embedding-3-small` answers with 1536 dimensions by default
    // (the semantic cache stores vectors of that size); every other model keeps the short form.
    const requestedModel = (req.body as { model?: string } | undefined)?.model ?? '';
    const dimensions = body.dimensions ?? (requestedModel === 'text-embedding-3-small' ? 1536 : 8);
    record(req, 200);
    return reply.send({
      object: 'list',
      data: inputs.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: embedding(text, dimensions),
      })),
      model: (req.body as { model?: string } | undefined)?.model ?? 'mock',
      usage: {
        prompt_tokens: inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
        total_tokens: inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
      },
    });
  });
  // ───────────── Legacy completions (card 30.4) ─────────────
  // Like OpenAI, only instruct models answer here; a chat model gets a 404.
  async function legacy(req: FastifyRequest, reply: FastifyReply, model: string) {
    const s = scenarioFor(req);
    await sleep(sampleLatency(s.latency));
    if (await maybeFail('openai', s, req, reply)) return;
    const body = (req.body ?? {}) as {
      prompt?: string | string[];
      n?: number;
      echo?: boolean;
      suffix?: string;
      max_tokens?: number;
      stream?: boolean;
    };
    if (!/instruct|davinci|babbage/.test(model)) {
      record(req, 404);
      return reply
        .status(404)
        .send(
          errorBody(
            'openai',
            404,
            'This is a chat model and not supported in the v1/completions endpoint.',
            'model_not_found',
          ),
        );
    }
    const prompts = Array.isArray(body.prompt) ? body.prompt : [body.prompt ?? ''];
    const n = body.n ?? 1;
    const words = s.text.split(' ');
    const text = words.slice(0, Math.max(1, body.max_tokens ?? 16)).join(' ') + (body.suffix ?? '');
    const truncated = text.length < s.text.length;
    const choices = prompts.flatMap((prompt, p) =>
      Array.from({ length: n }, (_, i) => ({
        text: body.echo ? `${prompt}${text}` : text,
        index: p * n + i,
        logprobs: null,
        finish_reason: truncated ? 'length' : 'stop',
      })),
    );
    const usage = {
      prompt_tokens: prompts.reduce((sum, prompt) => sum + tokens(prompt), 0),
      completion_tokens: tokens(text) * choices.length,
      total_tokens:
        prompts.reduce((sum, prompt) => sum + tokens(prompt), 0) + tokens(text) * choices.length,
    };
    record(req, 200);
    const id = `cmpl-mock${Date.now().toString(36)}`;
    if (!body.stream) {
      return reply.send({
        id,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices,
        usage,
      });
    }
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of choices)
      reply.raw.write(
        `data: ${JSON.stringify({ id, object: 'text_completion', model, choices: [{ ...choice, finish_reason: null }] })}\n\n`,
      );
    reply.raw.write(
      `data: ${JSON.stringify({ id, object: 'text_completion', model, choices: choices.map((c) => ({ ...c, text: '' })), usage })}\n\n`,
    );
    reply.raw.end('data: [DONE]\n\n');
    return reply;
  }
  app.post('/v1/completions', (req, reply) =>
    legacy(req, reply, (req.body as { model?: string } | undefined)?.model ?? 'mock'),
  );
  app.post<{ Params: { deployment: string } }>(
    '/openai/deployments/:deployment/completions',
    (req, reply) => legacy(req, reply, req.params.deployment),
  );

  // Azure OpenAI: /openai/deployments/{deployment}/chat/completions?api-version=...
  app.post<{ Params: { deployment: string } }>(
    '/openai/deployments/:deployment/chat/completions',
    (req, reply) => openai(req, reply, req.params.deployment),
  );

  // ───────────── Anthropic ─────────────

  app.post('/v1/messages', async (req, reply) => {
    const s = scenarioFor(req);
    await sleep(sampleLatency(s.latency));
    if (await maybeFail('anthropic', s, req, reply)) return;
    const body = (req.body ?? {}) as {
      model?: string;
      messages?: unknown;
      system?: unknown;
      stream?: boolean;
    };
    const model = body.model ?? 'mock';
    const inputTokens = tokens([body.system, body.messages]);
    const id = `msg_mock${Date.now().toString(36)}`;
    // Structured output (card 27.1): native JSON text, or a call to the gateway's fallback tool.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const nativeSchema = anthropicNativeSchema(raw);
    const fallbackSchema = s.tool ? undefined : anthropicFallbackSchema(raw);
    const tool = s.tool ?? (fallbackSchema !== undefined ? STRUCTURED_OUTPUT_TOOL : undefined);
    const toolInput = fallbackSchema !== undefined ? sampleFor(fallbackSchema) : { city: 'Tehran' };
    const toolJson = JSON.stringify(toolInput);
    const text = nativeSchema !== undefined ? JSON.stringify(sampleFor(nativeSchema)) : s.text;
    const pieces = chunksOf(text, s.chunks);
    const outputTokens = tool ? 12 : pieces.length * 2;
    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    if (!body.stream) {
      record(req, 200);
      await sleep(s.ttftMs);
      return reply.send({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: tool
          ? [{ type: 'tool_use', id: 'toolu_mock1', name: tool, input: toolInput }]
          : [{ type: 'text', text }],
        stop_reason: tool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: s.noUsage ? { input_tokens: 0, output_tokens: 0 } : usage,
      });
    }

    record(req, 200);
    await sleep(s.ttftMs);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let sent = 0;
    const drop = () => s.dropAfter !== undefined && sent >= s.dropAfter;

    send('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    });
    if (tool) {
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_mock1', name: tool, input: {} },
      });
      const half = Math.ceil(toolJson.length / 2);
      for (const part of [toolJson.slice(0, half), toolJson.slice(half)]) {
        if (drop()) return res.destroy();
        await sleep(s.chunkDelayMs);
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: part },
        });
        sent++;
      }
    } else {
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      send('ping', { type: 'ping' });
      for (const piece of pieces) {
        if (drop()) return res.destroy();
        await sleep(s.chunkDelayMs);
        if (res.destroyed) return;
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: piece },
        });
        sent++;
      }
    }
    if (drop()) return res.destroy();
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: s.noUsage ? 0 : outputTokens },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });

  // ───────────── Gemini ─────────────
  // POST /v1beta/models/{model}:generateContent and :streamGenerateContent?alt=sse

  const gemini = async (path: string, req: FastifyRequest, reply: FastifyReply) => {
    const [rawModel = 'mock', action = ''] = path.split(':');
    const model = decodeURIComponent(rawModel);
    const isEmbedding = action === 'embedContent' || action === 'batchEmbedContents';
    if (!isEmbedding && action !== 'generateContent' && action !== 'streamGenerateContent')
      return reply.status(404).send(errorBody('gemini', 404, `unknown action ${action}`, ''));
    const s = scenarioFor(req);
    await sleep(sampleLatency(s.latency));
    if (await maybeFail('gemini', s, req, reply)) return;
    const body = (req.body ?? {}) as {
      contents?: unknown;
      systemInstruction?: unknown;
      content?: { parts?: { text?: string }[] };
      requests?: { content?: { parts?: { text?: string }[] } }[];
    };
    const textOf = (parts?: { text?: string }[]) => (parts ?? []).map((p) => p.text ?? '').join('');
    const embedValues = (text: string) =>
      Array.from({ length: 8 }, (_, i) => ((text.length + i) % 10) / 10);
    if (action === 'embedContent' || action === 'batchEmbedContents') {
      const texts =
        action === 'batchEmbedContents'
          ? (body.requests ?? []).map((r) => textOf(r.content?.parts))
          : [textOf(body.content?.parts)];
      const promptTokenCount = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      record(req, 200);
      return reply.send(
        action === 'batchEmbedContents'
          ? {
              embeddings: texts.map((text) => ({ values: embedValues(text) })),
              usageMetadata: { promptTokenCount },
            }
          : {
              embedding: { values: embedValues(texts[0] ?? '') },
              usageMetadata: { promptTokenCount },
            },
      );
    }
    const promptTokenCount = tokens([body.systemInstruction, body.contents]);
    const pieces = chunksOf(s.text, s.chunks);
    const candidatesTokenCount = s.tool ? 12 : pieces.length * 2;
    const usageMetadata = {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    };
    const responseId = `mockgem${Date.now().toString(36)}`;
    const functionPart = s.tool
      ? {
          functionCall: { name: s.tool, args: { city: 'Tehran' } },
          thoughtSignature: 'c2lnLW1vY2s=',
        }
      : undefined;
    const frame = (parts: unknown[], finish?: string, usage?: unknown) => ({
      candidates: [
        {
          content: { role: 'model', parts },
          ...(finish ? { finishReason: finish } : {}),
          index: 0,
        },
      ],
      ...(usage && !s.noUsage ? { usageMetadata: usage } : {}),
      modelVersion: model,
      responseId,
    });

    if (action === 'generateContent') {
      record(req, 200);
      await sleep(s.ttftMs);
      return reply.send(
        frame(functionPart ? [functionPart] : [{ text: s.text }], 'STOP', usageMetadata),
      );
    }

    record(req, 200);
    await sleep(s.ttftMs);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\r\n\r\n`);
    if (functionPart) {
      send(frame([functionPart], 'STOP', usageMetadata));
      return res.end();
    }
    let sent = 0;
    for (const [i, piece] of pieces.entries()) {
      if (s.dropAfter !== undefined && sent >= s.dropAfter) return res.destroy();
      await sleep(s.chunkDelayMs);
      if (res.destroyed) return;
      const last = i === pieces.length - 1;
      // As in real Gemini, usageMetadata is cumulative in every chunk.
      send(
        frame([{ text: piece }], last ? 'STOP' : undefined, {
          ...usageMetadata,
          candidatesTokenCount: (i + 1) * 2,
        }),
      );
      sent++;
    }
    res.end();
  };
  app.post<{ Params: { '*': string } }>('/v1beta/models/*', (req, reply) =>
    gemini(req.params['*'], req, reply),
  );
  // Vertex AI (card 27.4): /{v1|v1beta1}/projects/{p}/locations/{l}/publishers/google/models/{m}:{verb}
  // shares the Gemini handler; tokens from the mock OAuth endpoint are checked in the onRequest hook.
  for (const version of ['v1', 'v1beta1'])
    app.post<{ Params: { '*': string } }>(`/${version}/projects/*`, (req, reply) => {
      const at = req.params['*'].indexOf('/publishers/google/models/');
      if (at < 0) return reply.status(404).send(errorBody('gemini', 404, 'unknown path', ''));
      return gemini(req.params['*'].slice(at + '/publishers/google/models/'.length), req, reply);
    });

  app.get('/v1beta/models', async (req, reply) => {
    const s = scenarioFor(req);
    if (await maybeFail('gemini', s, req, reply)) return;
    return {
      models: [
        ['gemini-mock-flash', ['generateContent', 'countTokens']],
        ['gemini-mock-pro', ['generateContent']],
        ['text-embedding-mock', ['embedContent']],
      ].map(([id, methods]) => ({
        name: `models/${String(id)}`,
        displayName: String(id),
        supportedGenerationMethods: methods,
      })),
    };
  });

  // ───────────── models, control and stats ─────────────

  app.get('/v1/models', async (req, reply) => {
    const s = scenarioFor(req);
    if (await maybeFail('openai', s, req, reply)) return;
    return {
      object: 'list',
      data: ['mock-small', 'mock-large', 'mock-vision'].map((id) => ({
        id,
        object: 'model',
        created: 1_700_000_000,
        owned_by: 'dirouter-mock',
      })),
    };
  });

  registerPayments(app, options.payments);
  registerMcp(app);
  registerA2a(app);
  registerMedia(app);
  registerBatches(app);
  registerWorkersAi(app);
  registerBedrock(app, { record });
  registerCatalog(app);
  registerRealtime(app, {
    scenario: (headers) => scenarioFor({ headers }),
    stats: () => stats.realtime,
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/__mock/stats', () => stats);
  app.post('/__mock/reset', () => {
    stats = newStats();
    promptCache.clear();
    defaults = parseScenario(options.defaultDirectives, DEFAULT_SCENARIO);
    return { ok: true };
  });
  app.put<{ Body: { directives?: string } }>('/__mock/config', (req) => {
    defaults = parseScenario(req.body.directives, DEFAULT_SCENARIO);
    return { ok: true, defaults };
  });

  return app;
}
