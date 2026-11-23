/**
 * `auto*` aliases (card 20.4): turn a classification into a concrete model, alias or combo name.
 *
 * - `auto`: the target configured for the task type (coding, reasoning, summarization, chat)
 * - `auto/coding`, `auto/smart`: their fixed targets
 * - `auto/fast`: the pool entry with the lowest observed latency
 * - `auto/cheap`: the pool entry with the lowest price for a request of this size
 *
 * A target that cannot serve the request (images, tools, context length) is replaced by the
 * cheapest pool entry that can, and the reason says so.
 */
import type { GatewaySettings, ModelConfig } from '@dirouter/contracts';

import type { Classification } from './classifier.js';
import type { RouterStats } from './stats.js';

export const AUTO_ALIASES = [
  'auto',
  'auto/coding',
  'auto/smart',
  'auto/fast',
  'auto/cheap',
] as const;
export type AutoAlias = (typeof AUTO_ALIASES)[number];
export const isAutoAlias = (name: string): name is AutoAlias =>
  (AUTO_ALIASES as readonly string[]).includes(name);

export type AutoRoutingConfig = NonNullable<GatewaySettings['autoRouting']>;

export interface AutoDecision {
  alias: AutoAlias;
  target: string;
  taskType?: string;
  source: 'rules' | 'model' | 'fixed';
  reasons: string[];
}

export interface AutoContext {
  /** The models behind a name in the caller's scope (one for a model, several for a combo). */
  modelsOf: (name: string) => ModelConfig[] | undefined;
  stats: RouterStats;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

/** Whether a name can serve the request: at least one of its models has what it needs. */
function capable(models: ModelConfig[], c: Classification, ctx: AutoContext): boolean {
  const needed = ctx.estimatedInputTokens + ctx.maxOutputTokens;
  return models.some(
    (m) =>
      m.enabled &&
      (!c.needs.vision || m.capabilities.vision) &&
      (!c.needs.tools || m.capabilities.tools) &&
      (m.contextWindow === undefined || m.contextWindow >= needed),
  );
}

/** Price of this request on a name: its cheapest model, input estimate plus the output cap. */
function priceOf(models: ModelConfig[], ctx: AutoContext): number {
  let best = Number.POSITIVE_INFINITY;
  for (const m of models) {
    const price =
      (Number(m.pricing.inputPerMTok) * ctx.estimatedInputTokens +
        Number(m.pricing.outputPerMTok) * ctx.maxOutputTokens) /
      1_000_000;
    if (price < best) best = price;
  }
  return best;
}

function latencyOf(models: ModelConfig[], stats: RouterStats): number {
  let best = Number.POSITIVE_INFINITY;
  for (const m of models) {
    const latency = stats.peakLatency(m.id);
    if (latency !== undefined && latency < best) best = latency;
  }
  return best;
}

/** Pool entries that exist in the caller's scope and can serve the request. */
function usablePool(config: AutoRoutingConfig, c: Classification, ctx: AutoContext) {
  return config.pool
    .map((name) => ({ name, models: ctx.modelsOf(name) }))
    .filter(
      (e): e is { name: string; models: ModelConfig[] } =>
        e.models !== undefined && capable(e.models, c, ctx),
    );
}

const needsText = (c: Classification) =>
  [c.needs.vision && 'images', c.needs.tools && 'tools', c.needs.longContext && 'a long context']
    .filter(Boolean)
    .join(', ');

export function decideAuto(
  alias: AutoAlias,
  config: AutoRoutingConfig,
  c: Classification,
  ctx: AutoContext,
  source: 'rules' | 'model' = 'rules',
): AutoDecision | { error: string } {
  const reasons = [...c.reasons];
  if (alias === 'auto/fast' || alias === 'auto/cheap') {
    const pool = usablePool(config, c, ctx);
    if (pool.length === 0)
      return { error: `no model in the auto routing pool can serve this request` };
    const pick =
      alias === 'auto/fast'
        ? pool.reduce((a, b) =>
            latencyOf(b.models, ctx.stats) < latencyOf(a.models, ctx.stats) ? b : a,
          )
        : pool.reduce((a, b) => (priceOf(b.models, ctx) < priceOf(a.models, ctx) ? b : a));
    reasons.push(
      alias === 'auto/fast'
        ? Number.isFinite(latencyOf(pick.models, ctx.stats))
          ? `lowest latency in the pool (~${String(Math.round(latencyOf(pick.models, ctx.stats)))} ms)`
          : 'no latency measured yet: first capable pool entry'
        : `lowest price in the pool for this request (~$${priceOf(pick.models, ctx).toFixed(6)})`,
    );
    return { alias, target: pick.name, taskType: c.taskType, source: 'fixed', reasons };
  }

  const target =
    alias === 'auto/coding'
      ? config.targets.coding
      : alias === 'auto/smart'
        ? (config.targets.smart ?? config.targets.reasoning)
        : (config.targets[c.taskType] ?? config.targets.chat ?? config.pool[0]);
  if (!target) return { error: `no target configured for ${alias}` };
  if (alias === 'auto') reasons.push(`task type ${c.taskType} → ${target}`);
  else reasons.push(`${alias} → ${target}`);
  const models = ctx.modelsOf(target);
  if (models && capable(models, c, ctx))
    return {
      alias,
      target,
      taskType: c.taskType,
      source: alias === 'auto' ? source : 'fixed',
      reasons,
    };

  // The configured target cannot take this request: the cheapest pool entry that can.
  const pool = usablePool(config, c, ctx);
  if (pool.length === 0)
    return {
      error: `${target} cannot serve this request${needsText(c) ? ` (needs ${needsText(c)})` : ''} and no pool entry can`,
    };
  const fallback = pool.reduce((a, b) => (priceOf(b.models, ctx) < priceOf(a.models, ctx) ? b : a));
  reasons.push(
    models
      ? `${target} lacks ${needsText(c) || 'capacity'}: cheapest capable pool entry ${fallback.name}`
      : `${target} is not available: cheapest capable pool entry ${fallback.name}`,
  );
  return {
    alias,
    target: fallback.name,
    taskType: c.taskType,
    source: alias === 'auto' ? source : 'fixed',
    reasons,
  };
}
