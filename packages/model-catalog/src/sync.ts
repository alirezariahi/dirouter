/**
 * Catalog and price sync from external sources (card 27.5): pure parsing, validation and diffing.
 * The worker fetches the sources and writes the result; nothing here touches the network or the
 * database, so every rule is unit-tested.
 *
 * Two source formats are understood:
 * - LiteLLM's `model_prices_and_context_window.json` (an object keyed by model name, prices per
 *   token), the default public source;
 * - DiRouter's own catalog format (`{ "models": [CatalogEntry…] }`), e.g. an internal mirror
 *   that an operator curates by hand.
 */
import type { ModelPricing, PricingTier } from '@dirouter/contracts';
import { z } from 'zod';

import { CatalogEntry } from './catalog.js';

/** Default public source: LiteLLM's community-maintained price list. */
export const DEFAULT_CATALOG_SOURCE =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** LiteLLM `litellm_provider` → DiRouter provider type or preset (catalog `provider`). */
const LITELLM_PROVIDERS: Record<string, string> = {
  openai: 'openai',
  text_completion_openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'gemini',
  'vertex_ai-language-models': 'vertex',
  mistral: 'mistral',
  groq: 'groq',
  deepseek: 'deepseek',
  xai: 'xai',
  cohere: 'cohere',
  cohere_chat: 'cohere',
  together_ai: 'together',
  fireworks_ai: 'fireworks',
  openrouter: 'openrouter',
  cerebras: 'cerebras',
  bedrock: 'bedrock',
  bedrock_converse: 'bedrock',
  voyage: 'voyage',
  jina_ai: 'jina',
};
/** Key prefixes LiteLLM puts in front of the provider's own model id. */
const KEY_PREFIXES: Record<string, string[]> = {
  vertex: ['vertex_ai'],
  bedrock: ['bedrock', 'bedrock_converse'],
  cohere: ['cohere', 'cohere_chat'],
  jina: ['jina_ai'],
};
const MODES = new Set([
  'chat',
  'completion',
  'responses',
  'embedding',
  'image_generation',
  'audio_speech',
  'audio_transcription',
]);

/** Largest per-million-token price accepted from a source ($100k), to reject garbage. */
const MAX_PER_MTOK = 100_000;

/**
 * Exact decimal for `perToken × 10^shift`, rounded half-up to 8 decimals, without float maths:
 * `2.5e-6` per token → `"2.5"` per million. Undefined for a negative, non-finite or absurd value.
 */
export function scaleDecimal(value: unknown, shift: number): string | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  const [mantissa = '0', exp = '0'] = n.toExponential().split('e');
  const digits = mantissa.replace('.', '');
  // Position of the decimal point inside `digits` after scaling.
  const point = 1 + Number(exp) + shift;
  let intPart: string;
  let fracPart: string;
  if (point <= 0) {
    intPart = '0';
    fracPart = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    intPart = digits + '0'.repeat(point - digits.length);
    fracPart = '';
  } else {
    intPart = digits.slice(0, point);
    fracPart = digits.slice(point);
  }
  // Round to 8 decimals, half up.
  let units = BigInt(intPart + (fracPart + '00000000').slice(0, 8));
  if ((fracPart[8] ?? '0') >= '5') units += 1n;
  const whole = units / 100_000_000n;
  const frac = (units % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  const out = frac ? `${whole.toString()}.${frac}` : whole.toString();
  if (Number(out) > MAX_PER_MTOK) return undefined;
  return out;
}

const perMTok = (value: unknown) => scaleDecimal(value, 6);
const perUnit = (value: unknown) => scaleDecimal(value, 0);

/** `"2.50"` and `"2.5"` are the same price. */
export function normalizeUsd(value: string): string {
  if (!value.includes('.')) return value.replace(/^0+(?=\d)/, '');
  const [i = '0', f = ''] = value.split('.');
  const frac = f.replace(/0+$/, '');
  const int = i.replace(/^0+(?=\d)/, '');
  return frac ? `${int}.${frac}` : int;
}

/** Pricing with normalized decimals and no undefined fields, for comparison and storage. */
export function normalizePricing(pricing: ModelPricing): ModelPricing {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(pricing) as [string, unknown][];
  for (const [k, v] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (v === undefined) continue;
    if (k === 'tiers') {
      const tiers = (v as PricingTier[])
        .map((t) => normalizePricing(t as unknown as ModelPricing) as unknown as PricingTier)
        .sort((a, b) => a.aboveInputTokens - b.aboveInputTokens);
      if (tiers.length > 0) out[k] = tiers;
    } else if (k === 'serviceTiers') {
      const tiers = Object.entries(v as Record<string, ModelPricing>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, rates]) => [name, normalizePricing(rates)] as const);
      if (tiers.length > 0) out[k] = Object.fromEntries(tiers);
    } else if (typeof v === 'string') out[k] = normalizeUsd(v);
    else out[k] = v;
  }
  return out as ModelPricing;
}

export function samePricing(a: ModelPricing, b: ModelPricing): boolean {
  return JSON.stringify(normalizePricing(a)) === JSON.stringify(normalizePricing(b));
}

export interface SkippedEntry {
  key: string;
  reason: string;
}

export interface ParsedSource {
  format: 'litellm' | 'dirouter';
  entries: CatalogEntry[];
  skipped: SkippedEntry[];
}

const LiteLlmEntry = z.looseObject({
  litellm_provider: z.string(),
  mode: z.string().optional(),
  max_input_tokens: z.number().optional(),
  max_tokens: z.number().optional(),
  max_output_tokens: z.number().optional(),
  input_cost_per_token: z.union([z.number(), z.string()]).optional(),
  output_cost_per_token: z.union([z.number(), z.string()]).optional(),
  cache_read_input_token_cost: z.union([z.number(), z.string()]).optional(),
  cache_creation_input_token_cost: z.union([z.number(), z.string()]).optional(),
  output_cost_per_reasoning_token: z.union([z.number(), z.string()]).optional(),
  input_cost_per_token_batches: z.union([z.number(), z.string()]).optional(),
  output_cost_per_image: z.union([z.number(), z.string()]).optional(),
  input_cost_per_character: z.union([z.number(), z.string()]).optional(),
  input_cost_per_second: z.union([z.number(), z.string()]).optional(),
  input_cost_per_audio_token: z.union([z.number(), z.string()]).optional(),
  output_cost_per_audio_token: z.union([z.number(), z.string()]).optional(),
  supports_function_calling: z.boolean().optional(),
  supports_vision: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  supports_response_schema: z.boolean().optional(),
  deprecation_date: z.string().optional(),
});

const positiveInt = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

/** `input_cost_per_token_above_200k_tokens` and friends → tiers. */
function litellmTiers(raw: Record<string, unknown>): PricingTier[] {
  const byThreshold = new Map<number, Record<string, string>>();
  const fields: Record<string, keyof PricingTier> = {
    input_cost_per_token: 'inputPerMTok',
    output_cost_per_token: 'outputPerMTok',
    cache_read_input_token_cost: 'cacheReadPerMTok',
    cache_creation_input_token_cost: 'cacheWritePerMTok',
  };
  for (const [name, value] of Object.entries(raw)) {
    const match = /^(.+)_above_(\d+)k_tokens$/.exec(name);
    if (!match?.[1] || !match[2]) continue;
    const field = fields[match[1]];
    const price = perMTok(value);
    if (!field || price === undefined) continue;
    const threshold = Number(match[2]) * 1000;
    const tier = byThreshold.get(threshold) ?? {};
    tier[field] = price;
    byThreshold.set(threshold, tier);
  }
  return [...byThreshold.entries()]
    .filter(([, t]) => t.inputPerMTok !== undefined && t.outputPerMTok !== undefined)
    .sort(([a], [b]) => a - b)
    .slice(0, 8)
    .map(([aboveInputTokens, t]) => ({ aboveInputTokens, ...t }) as PricingTier);
}

/** `input_cost_per_token_flex`, `…_priority` and friends → service tier prices (card 31.5). */
function litellmServiceTiers(raw: Record<string, unknown>): ModelPricing['serviceTiers'] {
  const out: NonNullable<ModelPricing['serviceTiers']> = {};
  for (const tier of ['flex', 'priority'] as const) {
    const input = perMTok(raw[`input_cost_per_token_${tier}`]);
    const output = perMTok(raw[`output_cost_per_token_${tier}`]);
    if (input === undefined || output === undefined) continue;
    const cacheRead = perMTok(raw[`cache_read_input_token_cost_${tier}`]);
    out[tier] = {
      inputPerMTok: input,
      outputPerMTok: output,
      ...(cacheRead ? { cacheReadPerMTok: cacheRead } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function batchDiscount(input: string, batch: string | undefined): string | undefined {
  if (batch === undefined || Number(input) <= 0) return undefined;
  const ratio = Number(batch) / Number(input);
  if (!(ratio >= 0 && ratio < 1)) return undefined;
  return normalizeUsd((1 - ratio).toFixed(6));
}

function fromLiteLlm(name: string, raw: unknown): CatalogEntry | SkippedEntry {
  const parsed = LiteLlmEntry.safeParse(raw);
  if (!parsed.success) return { key: name, reason: 'malformed entry' };
  const e = parsed.data;
  const provider = LITELLM_PROVIDERS[e.litellm_provider];
  if (!provider) return { key: name, reason: `provider ${e.litellm_provider} not supported` };
  const mode = e.mode ?? 'chat';
  if (!MODES.has(mode)) return { key: name, reason: `mode ${mode} not supported` };

  const prefixes = [e.litellm_provider, provider, ...(KEY_PREFIXES[provider] ?? [])];
  const slash = name.indexOf('/');
  const upstreamModel =
    slash > 0 && prefixes.includes(name.slice(0, slash)) ? name.slice(slash + 1) : name;
  if (!upstreamModel || upstreamModel.length > 200) return { key: name, reason: 'bad model id' };

  const media = mode === 'image_generation' || mode.startsWith('audio_');
  const input = perMTok(e.input_cost_per_token) ?? (media ? '0' : undefined);
  const output =
    perMTok(e.output_cost_per_token) ?? (mode === 'embedding' || media ? '0' : undefined);
  if (input === undefined || output === undefined)
    return { key: name, reason: 'no valid input/output price' };

  const cacheRead = perMTok(e.cache_read_input_token_cost);
  const cacheWrite = perMTok(e.cache_creation_input_token_cost);
  const reasoning = perMTok(e.output_cost_per_reasoning_token);
  const image = perUnit(e.output_cost_per_image);
  const chars = perMTok(e.input_cost_per_character);
  const seconds = perUnit(e.input_cost_per_second);
  const audioIn = perMTok(e.input_cost_per_audio_token);
  const audioOut = perMTok(e.output_cost_per_audio_token);
  // Realtime models (card 30.5) are the chat models named so that price audio tokens.
  const realtime =
    /realtime/.test(upstreamModel) && (audioIn !== undefined || audioOut !== undefined);
  const tiers = litellmTiers(e);
  const discount = batchDiscount(input, perMTok(e.input_cost_per_token_batches));
  const serviceTiers = litellmServiceTiers(e);
  const pricing: ModelPricing = {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cacheRead ? { cacheReadPerMTok: cacheRead } : {}),
    ...(cacheWrite ? { cacheWritePerMTok: cacheWrite } : {}),
    ...(reasoning ? { reasoningPerMTok: reasoning } : {}),
    ...(image && mode === 'image_generation' ? { perImageUsd: image } : {}),
    ...(chars && mode === 'audio_speech' ? { perMCharUsd: chars } : {}),
    ...(seconds && mode === 'audio_transcription' ? { perSecondUsd: seconds } : {}),
    ...(audioIn && realtime ? { audioInputPerMTok: audioIn } : {}),
    ...(audioOut && realtime ? { audioOutputPerMTok: audioOut } : {}),
    ...(tiers.length > 0 ? { tiers } : {}),
    ...(discount && discount !== '0' ? { batchDiscount: discount } : {}),
    ...(serviceTiers ? { serviceTiers } : {}),
  };
  const contextWindow = positiveInt(e.max_input_tokens) ?? positiveInt(e.max_tokens);
  const maxOutputTokens = positiveInt(e.max_output_tokens);
  const deprecationDate = /^\d{4}-\d{2}-\d{2}$/.test(e.deprecation_date ?? '')
    ? e.deprecation_date
    : undefined;
  const candidate = {
    key: `${provider}/${upstreamModel}`,
    provider,
    upstreamModel,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    pricing,
    capabilities: {
      streaming: mode !== 'embedding' && !media,
      tools: e.supports_function_calling === true,
      vision: e.supports_vision === true,
      reasoning: e.supports_reasoning === true,
      jsonMode: e.supports_response_schema === true,
      embeddings: mode === 'embedding',
      ...(mode === 'image_generation' ? { images: true } : {}),
      ...(mode === 'audio_speech' ? { speech: true } : {}),
      ...(mode === 'audio_transcription' ? { transcription: true } : {}),
      ...(realtime ? { realtime: true } : {}),
    },
    ...(deprecationDate ? { deprecationDate } : {}),
    mode,
  };
  const checked = CatalogEntry.safeParse(candidate);
  return checked.success ? checked.data : { key: name, reason: 'fails catalog validation' };
}

const keyOf = (raw: unknown) => {
  const key = (raw as { key?: unknown } | null)?.key;
  return typeof key === 'string' ? key : '?';
};

/**
 * Parses one source document. Invalid entries are skipped (and reported); a document with no
 * valid entry at all is rejected, so a broken or truncated source never empties the catalog.
 */
export function parseCatalogSource(json: unknown): ParsedSource {
  const entries: CatalogEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();
  const add = (result: CatalogEntry | SkippedEntry) => {
    if ('reason' in result) skipped.push(result);
    else if (seen.has(result.key)) skipped.push({ key: result.key, reason: 'duplicate key' });
    else {
      seen.add(result.key);
      entries.push({ ...result, pricing: normalizePricing(result.pricing) });
    }
  };
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw new Error('catalog source is not a JSON object');

  const models = (json as { models?: unknown }).models;
  let format: ParsedSource['format'];
  if (Array.isArray(models)) {
    format = 'dirouter';
    for (const raw of models) {
      const parsed = CatalogEntry.safeParse(raw);
      add(parsed.success ? parsed.data : { key: keyOf(raw), reason: 'invalid entry' });
    }
  } else {
    format = 'litellm';
    for (const [name, raw] of Object.entries(json as Record<string, unknown>)) {
      if (name === 'sample_spec') continue;
      add(fromLiteLlm(name, raw));
    }
  }
  if (entries.length === 0) throw new Error('catalog source has no valid model entries');
  return { format, entries, skipped };
}

/** Several sources: earlier sources win for the same key. */
export function mergeSources(sources: ParsedSource[]): CatalogEntry[] {
  const out = new Map<string, CatalogEntry>();
  for (const source of sources)
    for (const entry of source.entries) if (!out.has(entry.key)) out.set(entry.key, entry);
  return [...out.values()];
}

export interface PriceChange {
  key: string;
  before: CatalogEntry;
  after: CatalogEntry;
  /** Largest ratio between old and new token rates (≥ 1); Infinity when a rate became 0 or appeared. */
  factor: number;
}

export interface CatalogDiff {
  added: CatalogEntry[];
  priceChanged: PriceChange[];
  /** Context window, capabilities, deprecation… changed but the price did not. */
  metadataChanged: CatalogEntry[];
  /** Keys present in `current` (from earlier syncs) that the sources no longer list. */
  removed: string[];
  unchanged: number;
}

const metadataOf = (e: CatalogEntry) =>
  JSON.stringify([
    e.provider,
    e.upstreamModel,
    e.contextWindow ?? null,
    e.maxOutputTokens ?? null,
    Object.entries(e.capabilities).sort(([a], [b]) => a.localeCompare(b)),
    e.deprecationDate ?? null,
    e.mode ?? null,
  ]);

function changeFactor(before: ModelPricing, after: ModelPricing): number {
  let factor = 1;
  for (const k of ['inputPerMTok', 'outputPerMTok'] as const) {
    const a = Number(before[k]);
    const b = Number(after[k]);
    if (a === b) continue;
    if (a === 0 || b === 0) return Infinity;
    factor = Math.max(factor, a > b ? a / b : b / a);
  }
  return factor;
}

/**
 * What the sources change in the current catalog. `syncedKeys` are the keys that earlier syncs
 * stored (only those can be "removed"; bundled entries a source does not list stay as they are).
 */
export function diffCatalog(
  current: CatalogEntry[],
  incoming: CatalogEntry[],
  syncedKeys: ReadonlySet<string> = new Set(),
): CatalogDiff {
  const byKey = new Map(current.map((e) => [e.key, e]));
  const diff: CatalogDiff = {
    added: [],
    priceChanged: [],
    metadataChanged: [],
    removed: [],
    unchanged: 0,
  };
  const seen = new Set<string>();
  for (const next of incoming) {
    seen.add(next.key);
    const prev = byKey.get(next.key);
    if (!prev) {
      diff.added.push(next);
      continue;
    }
    const priceSame = samePricing(prev.pricing, next.pricing);
    if (!priceSame)
      diff.priceChanged.push({
        key: next.key,
        before: prev,
        after: next,
        factor: changeFactor(prev.pricing, next.pricing),
      });
    else if (metadataOf(prev) !== metadataOf(next)) diff.metadataChanged.push(next);
    else diff.unchanged++;
  }
  for (const key of syncedKeys) if (!seen.has(key) && byKey.has(key)) diff.removed.push(key);
  return diff;
}

/**
 * Refuses a sync whose sources look truncated: when earlier syncs stored at least 20 models and the
 * sources now list fewer than half of them, nothing is applied and the last good catalog stays.
 */
export function shrinkError(syncedCount: number, removedCount: number): string | undefined {
  if (syncedCount < 20) return undefined;
  if (removedCount * 2 > syncedCount)
    return `sources dropped ${String(removedCount)} of ${String(syncedCount)} synced models; refusing a truncated catalog`;
  return undefined;
}
