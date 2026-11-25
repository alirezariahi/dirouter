/**
 * OpenTelemetry GenAI semantic conventions (card 24.3).
 *
 * Target: semantic conventions **v1.41.0**, the last release of the core repository that carries
 * the GenAI conventions (status: Development). From v1.42.0 they live in
 * open-telemetry/semantic-conventions-genai; see docs/observability.md for what differs there.
 *
 * - v1.37.0 renamed `gen_ai.system` to `gen_ai.provider.name`; we send the new name only.
 * - Span name: `{gen_ai.operation.name} {gen_ai.request.model}`; the upstream call is a CLIENT span.
 * - Metrics: `gen_ai.client.token.usage` ({token}, by `gen_ai.token.type`) and
 *   `gen_ai.client.operation.duration` (s).
 *
 * Attributes are metadata only. The opt-in content attributes (`gen_ai.input.messages`,
 * `gen_ai.output.messages`, …) are never set: prompts stay out of traces.
 */
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalUsage,
  InboundApi,
  ProviderType,
} from '@dirouter/contracts';

export const GENAI_SEMCONV_VERSION = '1.41.0';
export const GENAI_SCHEMA_URL = `https://opentelemetry.io/schemas/${GENAI_SEMCONV_VERSION}`;

export type AttributeMode = 'both' | 'gen_ai' | 'legacy';
export type AttributeValue = string | number | boolean | string[];
export type Attributes = Record<string, AttributeValue>;

/** Well-known `gen_ai.provider.name` values of v1.41.0; other types are sent as they are. */
const PROVIDER_NAMES: Partial<Record<ProviderType, string>> = {
  openai: 'openai',
  'azure-openai': 'azure.ai.openai',
  anthropic: 'anthropic',
  gemini: 'gcp.gemini',
  vertex: 'gcp.vertex_ai',
  bedrock: 'aws.bedrock',
  cohere: 'cohere',
  mistral: 'mistral_ai',
};

export function genAiProviderName(type: ProviderType): string {
  return PROVIDER_NAMES[type] ?? type;
}

/** `gen_ai.operation.name`: Gemini's generateContent has its own value, every chat API is `chat`. */
export function genAiOperation(api: InboundApi): string {
  if (api === 'gemini.generate') return 'generate_content';
  if (api === 'openai.embeddings') return 'embeddings';
  return 'chat';
}

/** Request attributes known before routing. */
export function genAiRequestAttributes(api: InboundApi, request: CanonicalRequest): Attributes {
  return {
    'gen_ai.operation.name': genAiOperation(api),
    'gen_ai.request.model': request.model,
    ...(request.maxOutputTokens !== undefined
      ? { 'gen_ai.request.max_tokens': request.maxOutputTokens }
      : {}),
    ...(request.temperature !== undefined
      ? { 'gen_ai.request.temperature': request.temperature }
      : {}),
    ...(request.topP !== undefined ? { 'gen_ai.request.top_p': request.topP } : {}),
    ...(request.topK !== undefined ? { 'gen_ai.request.top_k': request.topK } : {}),
    ...(request.seed !== undefined ? { 'gen_ai.request.seed': request.seed } : {}),
    ...(request.stop?.length ? { 'gen_ai.request.stop_sequences': request.stop } : {}),
  };
}

/** What the model answered: id, model, finish reasons and token usage. */
export function genAiResponseAttributes(
  response: CanonicalResponse | undefined,
  usage: CanonicalUsage | undefined,
  responseModel?: string,
): Attributes {
  const model = responseModel ?? response?.model;
  const total = usage ?? response?.usage;
  return {
    ...(response?.id ? { 'gen_ai.response.id': response.id } : {}),
    ...(model ? { 'gen_ai.response.model': model } : {}),
    ...(response ? { 'gen_ai.response.finish_reasons': [response.finishReason] } : {}),
    ...(total
      ? {
          'gen_ai.usage.input_tokens': total.inputTokens,
          'gen_ai.usage.output_tokens': total.outputTokens,
          ...(total.cacheReadTokens > 0
            ? { 'gen_ai.usage.cache_read.input_tokens': total.cacheReadTokens }
            : {}),
          ...(total.cacheWriteTokens > 0
            ? { 'gen_ai.usage.cache_creation.input_tokens': total.cacheWriteTokens }
            : {}),
          ...(total.reasoningTokens > 0
            ? { 'gen_ai.usage.reasoning.output_tokens': total.reasoningTokens }
            : {}),
        }
      : {}),
  };
}

/** `server.address` and `server.port` of the provider's base URL. */
export function serverAttributes(baseUrl: string): Attributes {
  try {
    const url = new URL(baseUrl);
    const port = url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
    return { 'server.address': url.hostname, 'server.port': port };
  } catch {
    return {};
  }
}

const isLegacy = (key: string) => key.startsWith('gateway.');

/**
 * Keeps the attributes the mode asks for. `legacy` drops the conventions (including `error.type`
 * and `server.*`), `gen_ai` drops the `gateway.*` names, `both` keeps everything.
 */
export function shapeAttributes(mode: AttributeMode, attributes: Attributes): Attributes {
  if (mode === 'both') return attributes;
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) =>
      mode === 'legacy' ? isLegacy(key) : !isLegacy(key),
    ),
  );
}

/**
 * `error.type` for a failure recorded with a legacy key: the error class of an attempt, the reason
 * a request was refused, or `guardrail`.
 */
export function withErrorType(attributes: Attributes): Attributes {
  const type =
    attributes['gateway.error_class'] ??
    attributes['gateway.error'] ??
    (attributes['gateway.guardrail'] !== undefined ? 'guardrail' : undefined);
  return type === undefined || attributes['error.type'] !== undefined
    ? attributes
    : { ...attributes, 'error.type': String(type) };
}
