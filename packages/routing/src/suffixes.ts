/**
 * Model suffixes (card 31.5), as OpenRouter users know them: `model:nitro` (fastest first),
 * `model:floor` (cheapest first), `model:free` (free targets only), `model:online` (web search),
 * and reasoning: `model:thinking` or an effort `model:minimal|low|medium|high`. Suffixes can be
 * chained (`gpt:floor:online`). A name that exists as written is never split, so an organization
 * can still name a model `x:free` itself.
 */
import type { CanonicalRequest } from '@dirouter/contracts';

export const MODEL_SUFFIXES = [
  'nitro',
  'floor',
  'free',
  'online',
  'thinking',
  'minimal',
  'low',
  'medium',
  'high',
] as const;
export type ModelSuffix = (typeof MODEL_SUFFIXES)[number];

type Effort = NonNullable<NonNullable<CanonicalRequest['reasoning']>['effort']>;

export interface SuffixRouting {
  /** The model name without its suffixes. */
  model: string;
  /** Suffixes in the order written. */
  suffixes: ModelSuffix[];
  /** `:nitro` sorts by throughput, `:floor` by price. */
  sort?: 'throughput' | 'price';
  /** `:free`: only targets that cost nothing. */
  freeOnly: boolean;
  /** `:online`: the request asks for web search. */
  webSearch: boolean;
  /** Reasoning effort from `:thinking` (medium) or an effort suffix. */
  reasoningEffort?: Effort;
}

const KNOWN: ReadonlySet<string> = new Set(MODEL_SUFFIXES);

export function parseModelSuffixes(
  name: string,
  exists: (model: string) => boolean,
): SuffixRouting {
  const none: SuffixRouting = { model: name, suffixes: [], freeOnly: false, webSearch: false };
  if (!name.includes(':') || exists(name)) return none;
  const suffixes: ModelSuffix[] = [];
  let model = name;
  for (;;) {
    const at = model.lastIndexOf(':');
    if (at <= 0) return none;
    const suffix = model.slice(at + 1);
    if (!KNOWN.has(suffix)) return none;
    suffixes.unshift(suffix as ModelSuffix);
    model = model.slice(0, at);
    if (exists(model)) break;
  }
  const out: SuffixRouting = { model, suffixes, freeOnly: false, webSearch: false };
  for (const s of suffixes) {
    if (s === 'nitro') out.sort = 'throughput';
    else if (s === 'floor') out.sort = 'price';
    else if (s === 'free') out.freeOnly = true;
    else if (s === 'online') out.webSearch = true;
    else if (s === 'thinking') out.reasoningEffort ??= 'medium';
    else out.reasoningEffort = s;
  }
  return out;
}
