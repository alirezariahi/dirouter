/**
 * The providers' own batch APIs (card 30.1): what DiRouter sends to start, follow, cancel and
 * collect a batch, and how results come back in OpenAI's batch output format.
 *
 * - OpenAI (and the mock, and OpenAI-compatible providers whose `options.batch` is true): the
 *   input file is uploaded with `purpose=batch` (model names rewritten to the upstream name), then
 *   `POST /batches`; output and error files are downloaded when the batch ends.
 * - Anthropic: each `/v1/chat/completions` line is translated to Messages parameters and sent with
 *   `POST /v1/messages/batches`; the results (JSONL) are translated back to chat completions.
 */
import {
  type CanonicalUsage,
  type ModelConfig,
  OpenAIChatCompletionRequest,
  type ProviderConfig,
} from '@dirouter/contracts';
import {
  adapterForProvider,
  ANTHROPIC_VERSION,
  encodeMultipart,
  presetFor,
  type UpstreamRequest,
} from '@dirouter/providers';
import { ulid } from '@dirouter/shared';
import { canonicalToOpenAIResponse, openAIRequestToCanonical } from '@dirouter/translator';

export type NativeBatchKind = 'openai' | 'anthropic';

/** Endpoints a batch line may call, per provider kind. */
export const BATCH_ENDPOINTS: Readonly<Record<NativeBatchKind, readonly string[]>> = {
  openai: ['/v1/chat/completions', '/v1/embeddings', '/v1/responses', '/v1/completions'],
  anthropic: ['/v1/chat/completions'],
};

export function nativeBatchKind(provider: ProviderConfig): NativeBatchKind | undefined {
  if (provider.type === 'openai' || provider.type === 'mock') return 'openai';
  if (provider.type === 'openai-compatible' && provider.options.batch === true) return 'openai';
  if (provider.type === 'anthropic') return 'anthropic';
  return undefined;
}

export interface BatchLine {
  custom_id: string;
  method: 'POST';
  url: string;
  body: Record<string, unknown>;
}

/** Common state of an upstream batch, whatever the provider. */
export interface UpstreamBatchState {
  status:
    | 'validating'
    | 'in_progress'
    | 'finalizing'
    | 'completed'
    | 'failed'
    | 'expired'
    | 'cancelling'
    | 'cancelled';
  requestCounts: { total: number; completed: number; failed: number };
  outputFileId?: string;
  errorFileId?: string;
  resultsUrl?: string;
  errors?: { code?: string; message?: string; line?: number | null }[];
}

export interface Target {
  provider: ProviderConfig;
  model: ModelConfig;
  apiKey: string;
  credentialHeaders?: Record<string, string> | undefined;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

function openaiHeaders(t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>) {
  return {
    ...(t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : {}),
    ...presetFor(t.provider).headers,
    ...t.credentialHeaders,
  };
}

function anthropicHeaders(t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>) {
  return {
    'x-api-key': t.apiKey,
    'anthropic-version':
      typeof t.provider.options.version === 'string'
        ? t.provider.options.version
        : ANTHROPIC_VERSION,
    ...t.credentialHeaders,
  };
}

// ───────────── OpenAI ─────────────

export const openaiBatch = {
  /** The client's JSONL with each line's model replaced by the upstream model name. */
  upload(t: Target, lines: BatchLine[]): UpstreamRequest {
    const jsonl = lines
      .map((l) => JSON.stringify({ ...l, body: { ...l.body, model: t.model.upstreamModel } }))
      .join('\n');
    const form = encodeMultipart([
      ['purpose', 'batch'],
      [
        'file',
        {
          data: new TextEncoder().encode(`${jsonl}\n`),
          filename: 'batch-input.jsonl',
          contentType: 'application/jsonl',
        },
      ],
    ]);
    return {
      url: `${trimSlash(t.provider.baseUrl)}/files`,
      method: 'POST',
      headers: { ...openaiHeaders(t), 'content-type': form.contentType },
      bytes: form.body,
    };
  },
  uploadedId(json: unknown): string {
    const id = str(rec(json).id);
    if (!id) throw new Error('the provider returned no file id');
    return id;
  },
  create(
    t: Target,
    input: { fileId: string; endpoint: string; completionWindow: string },
  ): UpstreamRequest {
    return {
      url: `${trimSlash(t.provider.baseUrl)}/batches`,
      method: 'POST',
      headers: { ...openaiHeaders(t), 'content-type': 'application/json' },
      body: JSON.stringify({
        input_file_id: input.fileId,
        endpoint: input.endpoint,
        completion_window: input.completionWindow,
      }),
    };
  },
  status(
    t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>,
    id: string,
  ): UpstreamRequest {
    return {
      url: `${trimSlash(t.provider.baseUrl)}/batches/${encodeURIComponent(id)}`,
      method: 'GET',
      headers: openaiHeaders(t),
    };
  },
  cancel(
    t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>,
    id: string,
  ): UpstreamRequest {
    return {
      url: `${trimSlash(t.provider.baseUrl)}/batches/${encodeURIComponent(id)}/cancel`,
      method: 'POST',
      headers: openaiHeaders(t),
    };
  },
  content(
    t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>,
    fileId: string,
  ): UpstreamRequest {
    return {
      url: `${trimSlash(t.provider.baseUrl)}/files/${encodeURIComponent(fileId)}/content`,
      method: 'GET',
      headers: openaiHeaders(t),
    };
  },
  parse(json: unknown): UpstreamBatchState {
    const b = rec(json);
    const counts = rec(b.request_counts);
    const errors = rec(b.errors).data;
    const status = str(b.status) ?? 'in_progress';
    const known = [
      'validating',
      'in_progress',
      'finalizing',
      'completed',
      'failed',
      'expired',
      'cancelling',
      'cancelled',
    ];
    return {
      status: (known.includes(status) ? status : 'in_progress') as UpstreamBatchState['status'],
      requestCounts: {
        total: num(counts.total),
        completed: num(counts.completed),
        failed: num(counts.failed),
      },
      ...(str(b.output_file_id) ? { outputFileId: str(b.output_file_id) } : {}),
      ...(str(b.error_file_id) ? { errorFileId: str(b.error_file_id) } : {}),
      ...(Array.isArray(errors)
        ? {
            errors: errors.map((e) => ({
              ...(str(rec(e).code) ? { code: str(rec(e).code) } : {}),
              ...(str(rec(e).message) ? { message: str(rec(e).message) } : {}),
              line: typeof rec(e).line === 'number' ? (rec(e).line as number) : null,
            })),
          }
        : {}),
    };
  },
};

// ───────────── Anthropic ─────────────

export const anthropicBatch = {
  /** Every line translated to Messages parameters; a line that cannot be translated throws. */
  create(t: Target, lines: BatchLine[]): UpstreamRequest {
    const adapter = adapterForProvider(t.provider);
    const requests = lines.map((line, index) => {
      const parsed = OpenAIChatCompletionRequest.safeParse(line.body);
      if (!parsed.success)
        throw new Error(`line ${String(index + 1)}: not a valid chat completion request`);
      const request = openAIRequestToCanonical(parsed.data);
      const built = adapter.buildRequest({
        provider: t.provider,
        model: t.model,
        apiKey: t.apiKey,
        ...(t.credentialHeaders ? { credentialHeaders: t.credentialHeaders } : {}),
        request: { ...request, stream: false, model: t.model.upstreamModel },
      });
      const params = JSON.parse(built.body ?? '{}') as Record<string, unknown>;
      delete params.stream;
      return { custom_id: line.custom_id, params };
    });
    return {
      url: `${trimSlash(t.provider.baseUrl)}/v1/messages/batches`,
      method: 'POST',
      headers: { ...anthropicHeaders(t), 'content-type': 'application/json' },
      body: JSON.stringify({ requests }),
    };
  },
  createdId(json: unknown): string {
    const id = str(rec(json).id);
    if (!id) throw new Error('the provider returned no batch id');
    return id;
  },
  status(
    t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>,
    id: string,
  ): UpstreamRequest {
    return {
      url: `${trimSlash(t.provider.baseUrl)}/v1/messages/batches/${encodeURIComponent(id)}`,
      method: 'GET',
      headers: anthropicHeaders(t),
    };
  },
  cancel(
    t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>,
    id: string,
  ): UpstreamRequest {
    return {
      url: `${trimSlash(t.provider.baseUrl)}/v1/messages/batches/${encodeURIComponent(id)}/cancel`,
      method: 'POST',
      headers: anthropicHeaders(t),
    };
  },
  /**
   * Results are fetched from the provider's own origin only: a `results_url` elsewhere is
   * replaced by the documented path under the provider's base URL.
   */
  results(
    t: Pick<Target, 'provider' | 'apiKey' | 'credentialHeaders'>,
    id: string,
    resultsUrl: string | undefined,
  ): UpstreamRequest {
    const base = trimSlash(t.provider.baseUrl);
    let url = `${base}/v1/messages/batches/${encodeURIComponent(id)}/results`;
    if (resultsUrl) {
      try {
        if (new URL(resultsUrl).origin === new URL(base).origin) url = resultsUrl;
      } catch {
        // keep the documented path
      }
    }
    return { url, method: 'GET', headers: anthropicHeaders(t) };
  },
  parse(json: unknown, cancelling: boolean): UpstreamBatchState {
    const b = rec(json);
    const c = rec(b.request_counts);
    const succeeded = num(c.succeeded);
    const failed = num(c.errored) + num(c.canceled) + num(c.expired);
    const total = succeeded + failed + num(c.processing);
    const processing = str(b.processing_status);
    const ended = processing === 'ended';
    const status: UpstreamBatchState['status'] = !ended
      ? processing === 'canceling' || cancelling
        ? 'cancelling'
        : 'in_progress'
      : cancelling || num(c.canceled) > 0
        ? 'cancelled'
        : succeeded === 0 && num(c.expired) > 0
          ? 'expired'
          : 'completed';
    return {
      status,
      requestCounts: { total, completed: succeeded, failed },
      ...(str(b.results_url) ? { resultsUrl: str(b.results_url) } : {}),
    };
  },
};

// ───────────── Results ─────────────

export interface ConvertedResults {
  output: string[];
  errors: string[];
  usage: CanonicalUsage;
}

const zeroUsage = (): CanonicalUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

/** Usage of one OpenAI response body: chat completions, embeddings or Responses. */
export function usageOfBody(body: unknown): CanonicalUsage {
  const u = rec(rec(body).usage);
  const responses = 'input_tokens' in u || 'output_tokens' in u;
  return {
    inputTokens: num(responses ? u.input_tokens : u.prompt_tokens),
    outputTokens: num(responses ? u.output_tokens : u.completion_tokens),
    cacheReadTokens: num(
      rec(responses ? u.input_tokens_details : u.prompt_tokens_details).cached_tokens,
    ),
    cacheWriteTokens: 0,
    reasoningTokens: num(
      rec(responses ? u.output_tokens_details : u.completion_tokens_details).reasoning_tokens,
    ),
  };
}

export function addUsage(into: CanonicalUsage, more: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: into.inputTokens + more.inputTokens,
    outputTokens: into.outputTokens + more.outputTokens,
    cacheReadTokens: into.cacheReadTokens + more.cacheReadTokens,
    cacheWriteTokens: into.cacheWriteTokens + more.cacheWriteTokens,
    reasoningTokens: into.reasoningTokens + more.reasoningTokens,
  };
}

const jsonLines = (text: string): unknown[] =>
  text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as unknown];
      } catch {
        return [];
      }
    });

/**
 * OpenAI output and error files: the output keeps the provider's lines, with the model shown as
 * the name the client asked for; usage is summed over successful lines.
 */
export function convertOpenAIResults(
  output: string,
  errors: string,
  requestedModel: string,
): ConvertedResults {
  let usage = zeroUsage();
  const out = jsonLines(output).map((line) => {
    const l = rec(line);
    const response = rec(l.response);
    const body = rec(response.body);
    if (num(response.status_code) >= 200 && num(response.status_code) < 300)
      usage = addUsage(usage, usageOfBody(body));
    return JSON.stringify(
      'model' in body
        ? { ...l, response: { ...response, body: { ...body, model: requestedModel } } }
        : l,
    );
  });
  return { output: out, errors: jsonLines(errors).map((l) => JSON.stringify(l)), usage };
}

/** Anthropic results (`{custom_id, result: {type, message | error}}`) as OpenAI batch lines. */
export function convertAnthropicResults(
  results: string,
  t: Pick<Target, 'provider' | 'model'>,
  requestedModel: string,
): ConvertedResults {
  const adapter = adapterForProvider(t.provider);
  let usage = zeroUsage();
  const output: string[] = [];
  const errors: string[] = [];
  for (const line of jsonLines(results)) {
    const l = rec(line);
    const result = rec(l.result);
    const customId = str(l.custom_id) ?? '';
    const id = `batch_req_${ulid()}`;
    if (result.type === 'succeeded') {
      const canonical = adapter.parseResponse(result.message, t.model.upstreamModel);
      if (canonical.usage) usage = addUsage(usage, canonical.usage);
      output.push(
        JSON.stringify({
          id,
          custom_id: customId,
          response: {
            status_code: 200,
            request_id: str(rec(result.message).id) ?? id,
            body: canonicalToOpenAIResponse(canonical, { model: requestedModel }),
          },
          error: null,
        }),
      );
      continue;
    }
    const error = rec(rec(result.error).error ?? result.error);
    errors.push(
      JSON.stringify({
        id,
        custom_id: customId,
        response: null,
        error: {
          code: result.type === 'errored' ? (str(error.type) ?? 'errored') : String(result.type),
          message:
            str(error.message) ??
            (result.type === 'canceled'
              ? 'The request was cancelled before it ran.'
              : result.type === 'expired'
                ? 'The batch expired before the request ran.'
                : 'The request failed.'),
        },
      }),
    );
  }
  return { output, errors, usage };
}
