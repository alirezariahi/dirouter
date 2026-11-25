/**
 * Fake batch APIs (card 30.1): OpenAI's Files and Batch API and Anthropic's Message Batches.
 *
 * A batch moves one step on every status read (validating → in_progress → completed for OpenAI,
 * in_progress → ended for Anthropic), so a client that polls sees the whole life cycle without
 * waiting. Each line is answered with a fixed reply and usage (input = a quarter of the request's
 * characters, output = 10 tokens); a line whose body contains `mock:fail` fails.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

interface StoredFile {
  id: string;
  filename: string;
  purpose: string;
  content: Buffer;
  createdAt: number;
}

interface Line {
  custom_id: string;
  url?: string;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
}

interface OpenAIBatch {
  id: string;
  endpoint: string;
  inputFileId: string;
  lines: Line[];
  status: string;
  createdAt: number;
  outputFileId?: string;
  errorFileId?: string;
  completed: number;
  failed: number;
}

interface AnthropicBatch {
  id: string;
  lines: Line[];
  status: 'in_progress' | 'canceling' | 'ended';
  cancelled: boolean;
  createdAt: number;
  results?: string;
}

export const MOCK_BATCH_OUTPUT_TOKENS = 10;
const now = () => Math.floor(Date.now() / 1000);
const fails = (line: Line) => JSON.stringify(line.body ?? line.params ?? {}).includes('mock:fail');
const inputTokens = (value: unknown) =>
  Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4));

function field(body: Buffer, name: string): string | undefined {
  return new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body.toString('latin1'))?.[1];
}

/** The file part of a multipart upload. */
function filePart(body: Buffer): { filename: string; content: Buffer } | undefined {
  const text = body.toString('latin1');
  const header = /filename="([^"]*)"[^\r]*\r\n(?:[^\r]+\r\n)*\r\n/.exec(text);
  if (!header) return undefined;
  const start = header.index + header[0].length;
  const boundary = text.slice(0, text.indexOf('\r\n'));
  const end = text.indexOf(`\r\n${boundary}`, start);
  return {
    filename: header[1] ?? 'file',
    content: body.subarray(start, end === -1 ? undefined : end),
  };
}

const openaiAuth = (req: FastifyRequest) =>
  typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');
const anthropicAuth = (req: FastifyRequest) => typeof req.headers['x-api-key'] === 'string';

export function registerBatches(app: FastifyInstance): void {
  const files = new Map<string, StoredFile>();
  const openai = new Map<string, OpenAIBatch>();
  const anthropic = new Map<string, AnthropicBatch>();
  let seq = 0;
  const id = (prefix: string) => `${prefix}${Date.now().toString(36)}${String(++seq)}`;
  /** Models seen in uploaded batch lines and Anthropic batch params, for tests. */
  const models: string[] = [];

  const fileView = (f: StoredFile) => ({
    id: f.id,
    object: 'file',
    bytes: f.content.length,
    created_at: f.createdAt,
    filename: f.filename,
    purpose: f.purpose,
    status: 'processed',
  });
  const save = (filename: string, purpose: string, content: string) => {
    const f = {
      id: id('file-mock'),
      filename,
      purpose,
      content: Buffer.from(content),
      createdAt: now(),
    };
    files.set(f.id, f);
    return f;
  };

  // ── OpenAI Files ──
  app.post('/v1/files', (req, reply) => {
    if (!openaiAuth(req)) return reply.status(401).send({ error: { message: 'missing key' } });
    if (!Buffer.isBuffer(req.body))
      return reply.status(400).send({ error: { message: 'multipart only' } });
    const part = filePart(req.body);
    if (!part) return reply.status(400).send({ error: { message: 'file is required' } });
    const f = save(
      part.filename,
      field(req.body, 'purpose') ?? 'batch',
      part.content.toString('utf8'),
    );
    return fileView(f);
  });
  app.get<{ Params: { id: string } }>('/v1/files/:id/content', (req, reply) => {
    const f = files.get(req.params.id);
    if (!f || !openaiAuth(req))
      return reply.status(404).send({ error: { message: 'No such file' } });
    return reply.type('application/octet-stream').send(f.content);
  });

  // ── OpenAI Batch ──
  const batchView = (b: OpenAIBatch) => ({
    id: b.id,
    object: 'batch',
    endpoint: b.endpoint,
    errors: null,
    input_file_id: b.inputFileId,
    completion_window: '24h',
    status: b.status,
    output_file_id: b.outputFileId ?? null,
    error_file_id: b.errorFileId ?? null,
    created_at: b.createdAt,
    request_counts: { total: b.lines.length, completed: b.completed, failed: b.failed },
  });

  function complete(b: OpenAIBatch) {
    const output: string[] = [];
    const errors: string[] = [];
    for (const line of b.lines) {
      const requestId = id('req_mock');
      const body = line.body ?? {};
      if (fails(line)) {
        errors.push(
          JSON.stringify({
            id: id('batch_req_mock'),
            custom_id: line.custom_id,
            response: {
              status_code: 400,
              request_id: requestId,
              body: { error: { message: 'mock failure', type: 'invalid_request_error' } },
            },
            error: null,
          }),
        );
        continue;
      }
      const input = inputTokens(body.messages ?? body.input);
      const embeddings = b.endpoint === '/v1/embeddings';
      output.push(
        JSON.stringify({
          id: id('batch_req_mock'),
          custom_id: line.custom_id,
          response: {
            status_code: 200,
            request_id: requestId,
            body: embeddings
              ? {
                  object: 'list',
                  data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
                  model: body.model,
                  usage: { prompt_tokens: input, total_tokens: input },
                }
              : {
                  id: id('chatcmpl-mock'),
                  object: 'chat.completion',
                  created: now(),
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: `Batch reply to ${line.custom_id}` },
                      finish_reason: 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: input,
                    completion_tokens: MOCK_BATCH_OUTPUT_TOKENS,
                    total_tokens: input + MOCK_BATCH_OUTPUT_TOKENS,
                  },
                },
          },
          error: null,
        }),
      );
    }
    if (output.length > 0)
      b.outputFileId = save(`${b.id}_output.jsonl`, 'batch_output', `${output.join('\n')}\n`).id;
    if (errors.length > 0)
      b.errorFileId = save(`${b.id}_error.jsonl`, 'batch_output', `${errors.join('\n')}\n`).id;
    b.completed = output.length;
    b.failed = errors.length;
  }

  app.post('/v1/batches', (req, reply) => {
    if (!openaiAuth(req)) return reply.status(401).send({ error: { message: 'missing key' } });
    const body = (req.body ?? {}) as { input_file_id?: string; endpoint?: string };
    const f = files.get(body.input_file_id ?? '');
    if (!f) return reply.status(400).send({ error: { message: 'input file not found' } });
    const lines = f.content
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Line);
    for (const line of lines)
      if (typeof line.body?.model === 'string') models.push(line.body.model);
    const b: OpenAIBatch = {
      id: id('batch_mock'),
      endpoint: body.endpoint ?? '/v1/chat/completions',
      inputFileId: f.id,
      lines,
      status: 'validating',
      createdAt: now(),
      completed: 0,
      failed: 0,
    };
    openai.set(b.id, b);
    return batchView(b);
  });
  app.get<{ Params: { id: string } }>('/v1/batches/:id', (req, reply) => {
    const b = openai.get(req.params.id);
    if (!b || !openaiAuth(req))
      return reply.status(404).send({ error: { message: 'No such batch' } });
    if (b.status === 'validating') b.status = 'in_progress';
    else if (b.status === 'in_progress') {
      complete(b);
      b.status = 'completed';
    } else if (b.status === 'cancelling') b.status = 'cancelled';
    return batchView(b);
  });
  app.post<{ Params: { id: string } }>('/v1/batches/:id/cancel', (req, reply) => {
    const b = openai.get(req.params.id);
    if (!b || !openaiAuth(req))
      return reply.status(404).send({ error: { message: 'No such batch' } });
    if (b.status === 'validating' || b.status === 'in_progress') b.status = 'cancelling';
    return batchView(b);
  });

  // ── Anthropic Message Batches ──
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? 'localhost'}`;
  const anthropicView = (b: AnthropicBatch, req: FastifyRequest) => {
    const ended = b.status === 'ended';
    const failed = ended && !b.cancelled ? b.lines.filter(fails).length : 0;
    return {
      id: b.id,
      type: 'message_batch',
      processing_status: b.status,
      request_counts: {
        processing: ended ? 0 : b.lines.length,
        succeeded: ended && !b.cancelled ? b.lines.length - failed : 0,
        errored: failed,
        canceled: ended && b.cancelled ? b.lines.length : 0,
        expired: 0,
      },
      ended_at: ended ? new Date().toISOString() : null,
      created_at: new Date(b.createdAt * 1000).toISOString(),
      expires_at: new Date((b.createdAt + 86_400) * 1000).toISOString(),
      cancel_initiated_at: b.cancelled ? new Date().toISOString() : null,
      results_url: ended ? `${origin(req)}/v1/messages/batches/${b.id}/results` : null,
    };
  };
  app.post('/v1/messages/batches', (req, reply) => {
    if (!anthropicAuth(req))
      return reply
        .status(401)
        .send({ type: 'error', error: { type: 'authentication_error', message: 'missing key' } });
    const body = (req.body ?? {}) as { requests?: Line[] };
    const lines = body.requests ?? [];
    for (const line of lines)
      if (typeof line.params?.model === 'string') models.push(line.params.model);
    const b: AnthropicBatch = {
      id: id('msgbatch_mock'),
      lines,
      status: 'in_progress',
      cancelled: false,
      createdAt: now(),
    };
    anthropic.set(b.id, b);
    return anthropicView(b, req);
  });
  app.get<{ Params: { id: string } }>('/v1/messages/batches/:id', (req, reply) => {
    const b = anthropic.get(req.params.id);
    if (!b || !anthropicAuth(req))
      return reply
        .status(404)
        .send({ type: 'error', error: { type: 'not_found_error', message: 'No such batch' } });
    const view = anthropicView(b, req);
    b.status = 'ended';
    return view;
  });
  app.post<{ Params: { id: string } }>('/v1/messages/batches/:id/cancel', (req, reply) => {
    const b = anthropic.get(req.params.id);
    if (!b || !anthropicAuth(req))
      return reply
        .status(404)
        .send({ type: 'error', error: { type: 'not_found_error', message: 'No such batch' } });
    if (b.status !== 'ended') {
      b.status = 'canceling';
      b.cancelled = true;
    }
    return anthropicView(b, req);
  });
  app.get<{ Params: { id: string } }>('/v1/messages/batches/:id/results', (req, reply) => {
    const b = anthropic.get(req.params.id);
    if (!b || b.status !== 'ended' || !anthropicAuth(req))
      return reply
        .status(404)
        .send({ type: 'error', error: { type: 'not_found_error', message: 'No results' } });
    const lines = b.lines.map((line) => {
      if (b.cancelled) return { custom_id: line.custom_id, result: { type: 'canceled' } };
      if (fails(line))
        return {
          custom_id: line.custom_id,
          result: {
            type: 'errored',
            error: {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'mock failure' },
            },
          },
        };
      return {
        custom_id: line.custom_id,
        result: {
          type: 'succeeded',
          message: {
            id: id('msg_mock'),
            type: 'message',
            role: 'assistant',
            model: line.params?.model,
            content: [{ type: 'text', text: `Batch reply to ${line.custom_id}` }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens(line.params?.messages),
              output_tokens: MOCK_BATCH_OUTPUT_TOKENS,
            },
          },
        },
      };
    });
    return reply
      .type('application/x-jsonl')
      .send(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  });

  app.get('/__mock/batches', () => ({
    models,
    files: files.size,
    openai: openai.size,
    anthropic: anthropic.size,
  }));
}
