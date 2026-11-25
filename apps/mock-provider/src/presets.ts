/**
 * Mock routes of the providers added as presets in card 31.6, each in its own wire format:
 *
 * - OpenAI-compatible paths that are not `/v1/...`: Perplexity (`/chat/completions`), DeepInfra
 *   (`/v1/openai/...`) and Databricks (`/serving-endpoints/chat/completions`, endpoint list on
 *   `/api/2.0/serving-endpoints`). They answer like the OpenAI route.
 * - Replicate predictions (`Prefer: wait`) and the language-models collection.
 * - IBM IAM token exchange and watsonx.ai `text/chat`, `text/chat_stream`, model specs; a chat
 *   needs the issued token and a project or space id.
 * - SageMaker `invocations` and `ListEndpoints`; both need a SigV4 signature for `sagemaker`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

type Json = Record<string, unknown>;

export interface PresetHooks {
  /** The OpenAI chat handler of the mock (scenarios, streaming, tool calls). */
  openai: (req: FastifyRequest, reply: FastifyReply, model: string) => Promise<unknown>;
  record: (req: FastifyRequest, status: number) => void;
}

/** The token the mock IAM endpoint issues for any API key. */
export const MOCK_IAM_TOKEN = 'mock-iam-token';

const MOCK_TEXT = 'Hello from the DiRouter mock provider.';
const words = (text: string) => text.split(/(?<= )/);
const promptTokens = (value: unknown) =>
  Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4));

function sigv4Service(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  return typeof auth === 'string'
    ? /^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/[a-z0-9-]+\/([a-z0-9-]+)\/aws4_request/.exec(
        auth,
      )?.[1]
    : undefined;
}

export function registerPresets(app: FastifyInstance, hooks: PresetHooks): void {
  if (!app.hasContentTypeParser('application/x-amz-json-1.1'))
    app.addContentTypeParser(
      'application/x-amz-json-1.1',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, JSON.parse(String(body) || '{}'));
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );
  const model = (req: FastifyRequest) =>
    (req.body as { model?: string } | undefined)?.model ?? 'mock';

  // ───── OpenAI-compatible on other paths ─────
  app.post('/chat/completions', (req, reply) => hooks.openai(req, reply, model(req)));
  app.post('/v1/openai/chat/completions', (req, reply) => hooks.openai(req, reply, model(req)));
  app.get('/v1/openai/models', () => ({
    object: 'list',
    data: [{ id: 'meta-llama/Llama-3.3-70B-Instruct', object: 'model' }],
  }));
  app.post('/serving-endpoints/chat/completions', (req, reply) =>
    hooks.openai(req, reply, model(req)),
  );
  app.get('/api/2.0/serving-endpoints', () => ({
    endpoints: [
      { name: 'databricks-meta-llama-3-3-70b-instruct', task: 'llm/v1/chat' },
      { name: 'my-finetuned-endpoint', task: 'llm/v1/chat' },
    ],
  }));

  // ───── Replicate ─────
  const prediction = (req: FastifyRequest, reply: FastifyReply, name: string) => {
    const body = (req.body ?? {}) as { input?: Json; version?: string };
    if (req.headers.authorization?.startsWith('Bearer ') !== true) {
      hooks.record(req, 401);
      return reply.status(401).send({
        title: 'Unauthenticated',
        detail: 'You did not pass a valid authentication token',
        status: 401,
      });
    }
    if (typeof body.input?.prompt !== 'string') {
      hooks.record(req, 422);
      return reply.status(422).send({
        title: 'Input validation failed',
        detail: 'input: prompt is required',
        status: 422,
      });
    }
    hooks.record(req, 201);
    const output = words(MOCK_TEXT);
    return reply.status(201).send({
      id: `rp_mock${Date.now().toString(36)}`,
      model: name,
      version: body.version ?? 'latest',
      input: body.input,
      status: 'succeeded',
      output,
      metrics: { input_token_count: promptTokens(body.input), output_token_count: output.length },
    });
  };
  app.post<{ Params: { owner: string; name: string } }>(
    '/v1/models/:owner/:name/predictions',
    (req, reply) => prediction(req, reply, `${req.params.owner}/${req.params.name}`),
  );
  app.post('/v1/predictions', (req, reply) => prediction(req, reply, 'pinned-version'));
  app.get('/v1/collections/language-models', () => ({
    name: 'Language models',
    slug: 'language-models',
    models: [
      { owner: 'meta', name: 'meta-llama-3-70b-instruct' },
      { owner: 'ibm-granite', name: 'granite-3.3-8b-instruct' },
    ],
  }));

  // ───── IBM IAM and watsonx.ai ─────
  app.post('/identity/token', (req, reply) => {
    // The form body is parsed by the OAuth mock's form parser.
    const form = (req.body ?? {}) as Record<string, string | undefined>;
    if (form.grant_type !== 'urn:ibm:params:oauth:grant-type:apikey' || !form.apikey)
      return reply
        .status(400)
        .send({ errorCode: 'BXNIM0109E', errorMessage: 'Property missing or empty' });
    return reply.send({
      access_token: MOCK_IAM_TOKEN,
      refresh_token: 'not_supported',
      token_type: 'Bearer',
      expires_in: 3600,
      expiration: Math.floor(Date.now() / 1000) + 3600,
      scope: 'ibm openid',
    });
  });
  const watsonx = (req: FastifyRequest, reply: FastifyReply, stream: boolean) => {
    const body = (req.body ?? {}) as Json;
    if (req.headers.authorization !== `Bearer ${MOCK_IAM_TOKEN}`) {
      hooks.record(req, 401);
      return reply.status(401).send({
        errors: [
          {
            code: 'authentication_token_not_valid',
            message: 'Failed to authenticate the request due to invalid token',
          },
        ],
        status_code: 401,
      });
    }
    if (typeof body.model_id !== 'string' || (!body.project_id && !body.space_id)) {
      hooks.record(req, 400);
      return reply.status(400).send({
        errors: [
          {
            code: 'json_validation_error',
            message: 'Either project_id or space_id must be specified',
          },
        ],
        status_code: 400,
      });
    }
    hooks.record(req, 200);
    const id = `chat-mock${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = {
      prompt_tokens: promptTokens(body.messages),
      completion_tokens: 8,
      total_tokens: promptTokens(body.messages) + 8,
    };
    if (!stream)
      return reply.send({
        id,
        model_id: body.model_id,
        created,
        choices: [
          { index: 0, message: { role: 'assistant', content: MOCK_TEXT }, finish_reason: 'stop' },
        ],
        usage,
      });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let n = 0;
    const send = (data: unknown) =>
      res.write(`id: ${String(++n)}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`);
    const frame = (delta: Json, finish: string | null, extra: Json = {}) => ({
      id,
      model_id: body.model_id,
      created,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });
    send(frame({ role: 'assistant', content: '' }, null));
    for (const piece of words(MOCK_TEXT)) send(frame({ content: piece }, null));
    send(frame({}, 'stop', { usage }));
    res.end();
    return reply;
  };
  app.post('/ml/v1/text/chat', (req, reply) => watsonx(req, reply, false));
  app.post('/ml/v1/text/chat_stream', (req, reply) => watsonx(req, reply, true));
  app.get('/ml/v1/foundation_model_specs', () => ({
    total_count: 2,
    resources: [
      { model_id: 'ibm/granite-3-8b-instruct' },
      { model_id: 'meta-llama/llama-3-3-70b-instruct' },
    ],
  }));

  // ───── SageMaker ─────
  app.post<{ Params: { endpoint: string } }>('/endpoints/:endpoint/invocations', (req, reply) => {
    if (sigv4Service(req) !== 'sagemaker') {
      hooks.record(req, 403);
      return reply.status(403).send({
        message: 'The request signature we calculated does not match the signature you provided.',
      });
    }
    const body = (req.body ?? {}) as Json;
    if (!Array.isArray(body.messages)) {
      hooks.record(req, 400);
      return reply.status(400).send({ message: 'messages is required' });
    }
    hooks.record(req, 200);
    const prompt = promptTokens(body.messages);
    // A TGI/LMI Messages API answer: OpenAI-shaped.
    return reply.send({
      id: `sm-mock${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: typeof body.model === 'string' ? body.model : 'tgi',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: MOCK_TEXT },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: prompt, completion_tokens: 8, total_tokens: prompt + 8 },
    });
  });
  app.post('/', (req, reply) => {
    if (
      req.headers['x-amz-target'] !== 'SageMaker.ListEndpoints' ||
      sigv4Service(req) !== 'sagemaker'
    )
      return reply.status(400).send({ __type: 'UnknownOperationException' });
    return reply.send({
      Endpoints: [
        { EndpointName: 'llama-3-tgi', EndpointStatus: 'InService' },
        { EndpointName: 'mistral-lmi', EndpointStatus: 'InService' },
      ],
    });
  });
}
