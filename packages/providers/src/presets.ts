/**
 * Presets for OpenAI-compatible providers. Adding a new provider only needs config:
 * type `openai-compatible` + `baseUrl` (+ optional `options.maxTokensField`,
 * `options.supportsStreamOptions`, `options.headers`).
 */
import type { ProviderConfig } from '@dirouter/contracts';

export interface Preset {
  name: string;
  baseUrl: string;
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  supportsStreamOptions: boolean;
  headers: Record<string, string>;
  /** Does not require an API key (local server). */
  keyless?: boolean;
  /** Model list URL when it is not `{baseUrl}/models` (card 31.6). */
  modelsUrl?: (baseUrl: string) => string;
  /** Model ids from a list response that is not OpenAI's `{data: [{id}]}`. */
  parseModels?: (json: unknown) => string[];
  /** Models always offered by discovery, whatever the list returns. */
  staticModels?: readonly string[];
}

const trim = (url: string) => url.replace(/\/+$/, '');

const preset = (p: Partial<Preset> & Pick<Preset, 'name' | 'baseUrl'>): Preset => ({
  maxTokensField: 'max_tokens',
  supportsStreamOptions: true,
  headers: {},
  ...p,
});

export const PRESETS: Record<string, Preset> = {
  openai: preset({
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    maxTokensField: 'max_completion_tokens',
  }),
  openrouter: preset({
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    headers: { 'x-title': 'DiRouter' },
  }),
  deepseek: preset({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }),
  groq: preset({
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    maxTokensField: 'max_completion_tokens',
  }),
  together: preset({ name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' }),
  fireworks: preset({ name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' }),
  mistral: preset({
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    supportsStreamOptions: false,
  }),
  zai: preset({
    name: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    supportsStreamOptions: false,
  }),
  moonshot: preset({
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.ai/v1',
    supportsStreamOptions: false,
  }),
  minimax: preset({
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/v1',
    supportsStreamOptions: false,
  }),
  qwen: preset({
    name: 'Qwen (DashScope)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    supportsStreamOptions: false,
  }),
  siliconflow: preset({
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    supportsStreamOptions: false,
  }),
  voyage: preset({ name: 'Voyage AI', baseUrl: 'https://api.voyageai.com/v1' }),
  jina: preset({ name: 'Jina AI', baseUrl: 'https://api.jina.ai/v1' }),
  xai: preset({ name: 'xAI', baseUrl: 'https://api.x.ai/v1' }),
  cerebras: preset({
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    maxTokensField: 'max_completion_tokens',
  }),
  ollama: preset({ name: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyless: true }),
  vllm: preset({ name: 'vLLM', baseUrl: 'http://localhost:8000/v1', keyless: true }),
  mock: preset({ name: 'DiRouter mock', baseUrl: 'http://mock-provider:8090/v1' }),
  // ───── card 31.6 ─────
  perplexity: preset({
    name: 'Perplexity',
    // Sonar chat completions live at the root; the model list under /v1.
    baseUrl: 'https://api.perplexity.ai',
    modelsUrl: (base) => `${trim(base).replace(/\/v1$/, '')}/v1/models`,
    staticModels: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'],
  }),
  deepinfra: preset({ name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai' }),
  nvidia: preset({ name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' }),
  huggingface: preset({
    name: 'Hugging Face Inference Providers',
    baseUrl: 'https://router.huggingface.co/v1',
  }),
  databricks: preset({
    name: 'Databricks Model Serving',
    // Chat completions at {workspace}/serving-endpoints; the endpoint list on the REST API.
    baseUrl: 'https://<workspace>.cloud.databricks.com/serving-endpoints',
    modelsUrl: (base) =>
      `${trim(base).replace(/\/serving-endpoints$/, '')}/api/2.0/serving-endpoints`,
    parseModels: (json) => {
      const endpoints = (json as { endpoints?: { name?: unknown }[] } | undefined)?.endpoints;
      return Array.isArray(endpoints)
        ? endpoints.map((e) => e.name).filter((n): n is string => typeof n === 'string')
        : [];
    },
  }),
};

/**
 * Providers with their own wire protocol behind `type: openai-compatible` and a preset
 * (card 31.6); `adapterForProvider` gives them a dedicated adapter.
 */
export const PROTOCOL_PRESETS = ['replicate', 'watsonx', 'sagemaker'] as const;
export type ProtocolPreset = (typeof PROTOCOL_PRESETS)[number];

export function protocolPresetOf(
  provider: Pick<ProviderConfig, 'type' | 'options'>,
): ProtocolPreset | undefined {
  const name = provider.options.preset;
  return provider.type === 'openai-compatible' &&
    typeof name === 'string' &&
    (PROTOCOL_PRESETS as readonly string[]).includes(name)
    ? (name as ProtocolPreset)
    : undefined;
}

/** Effective preset of a provider: the preset named in options.preset, then options overrides. */
export function presetFor(
  provider: Pick<ProviderConfig, 'type' | 'options' | 'name' | 'baseUrl'>,
): Preset {
  const named =
    typeof provider.options.preset === 'string' ? PRESETS[provider.options.preset] : undefined;
  const fallback =
    PRESETS[provider.type] ?? (provider.type === 'openai' ? PRESETS.openai : undefined);
  const base = named ?? fallback ?? preset({ name: provider.name, baseUrl: provider.baseUrl });
  const opts = provider.options;
  const headers =
    opts.headers && typeof opts.headers === 'object'
      ? (opts.headers as Record<string, string>)
      : {};
  return {
    ...base,
    ...(opts.maxTokensField === 'max_tokens' || opts.maxTokensField === 'max_completion_tokens'
      ? { maxTokensField: opts.maxTokensField }
      : {}),
    ...(typeof opts.supportsStreamOptions === 'boolean'
      ? { supportsStreamOptions: opts.supportsStreamOptions }
      : {}),
    headers: { ...base.headers, ...headers },
  };
}
