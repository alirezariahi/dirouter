/**
 * provider ساختگی سازگار با OpenAI، Anthropic و Gemini با تزریق خطا (کارت‌های ۹.۱ و ۴.۸).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import {
  DEFAULT_SCENARIO,
  directivesFromKey,
  parseScenario,
  sampleLatency,
  type Scenario,
} from './scenario.js';

type Api = 'openai' | 'anthropic' | 'gemini';

interface Stats {
  requests: number;
  byKey: Record<string, number>;
  byStatus: Record<string, number>;
  /** آخرین بدنه‌های دریافتی (برای assert در تست e2e). */
  last: unknown[];
}

const newStats = (): Stats => ({ requests: 0, byKey: {}, byStatus: {}, last: [] });

/** تخمین ساده: هر ۴ کاراکتر یک توکن. */
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
}

export function buildServer(options: MockServerOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  let defaults = parseScenario(options.defaultDirectives, DEFAULT_SCENARIO);
  let stats = newStats();

  function scenarioFor(req: FastifyRequest): Scenario {
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
  }

  /** خطای ثابت یا تصادفی؛ اگر خطایی ارسال شد true برمی‌گرداند. */
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
    const pieces = chunksOf(s.text, s.chunks);
    const outputTokens = s.tool ? 12 : pieces.length * 2;
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
        content: s.tool
          ? [{ type: 'tool_use', id: 'toolu_mock1', name: s.tool, input: { city: 'Tehran' } }]
          : [{ type: 'text', text: s.text }],
        stop_reason: s.tool ? 'tool_use' : 'end_turn',
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
    if (s.tool) {
      send('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_mock1', name: s.tool, input: {} },
      });
      for (const part of ['{"city":', ' "Tehran"}']) {
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
      delta: { stop_reason: s.tool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: s.noUsage ? 0 : outputTokens },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });

  // ───────────── Gemini ─────────────
  // POST /v1beta/models/{model}:generateContent و :streamGenerateContent?alt=sse

  app.post<{ Params: { '*': string } }>('/v1beta/models/*', async (req, reply) => {
    const [rawModel = 'mock', action = ''] = req.params['*'].split(':');
    const model = decodeURIComponent(rawModel);
    if (action !== 'generateContent' && action !== 'streamGenerateContent')
      return reply.status(404).send(errorBody('gemini', 404, `unknown action ${action}`, ''));
    const s = scenarioFor(req);
    await sleep(sampleLatency(s.latency));
    if (await maybeFail('gemini', s, req, reply)) return;
    const body = (req.body ?? {}) as { contents?: unknown; systemInstruction?: unknown };
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
      // مثل Gemini واقعی usageMetadata در هر chunk تجمعی است.
      send(
        frame([{ text: piece }], last ? 'STOP' : undefined, {
          ...usageMetadata,
          candidatesTokenCount: (i + 1) * 2,
        }),
      );
      sent++;
    }
    res.end();
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

  // ───────────── models، کنترل و آمار ─────────────

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

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/__mock/stats', () => stats);
  app.post('/__mock/reset', () => {
    stats = newStats();
    defaults = parseScenario(options.defaultDirectives, DEFAULT_SCENARIO);
    return { ok: true };
  });
  app.put<{ Body: { directives?: string } }>('/__mock/config', (req) => {
    defaults = parseScenario(req.body.directives, DEFAULT_SCENARIO);
    return { ok: true, defaults };
  });

  return app;
}
