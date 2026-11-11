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
}

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
  xai: preset({ name: 'xAI', baseUrl: 'https://api.x.ai/v1' }),
  cerebras: preset({
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    maxTokensField: 'max_completion_tokens',
  }),
  ollama: preset({ name: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyless: true }),
  vllm: preset({ name: 'vLLM', baseUrl: 'http://localhost:8000/v1', keyless: true }),
  mock: preset({ name: 'DiRouter mock', baseUrl: 'http://mock-provider:8090/v1' }),
};

/** Effective preset of a provider: the preset named in options.preset, then options overrides. */
export function presetFor(provider: ProviderConfig): Preset {
  const named =
    typeof provider.options.preset === 'string' ? PRESETS[provider.options.preset] : undefined;
  const fallback = provider.type === 'openai' ? PRESETS.openai : undefined;
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
