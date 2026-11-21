/**
 * Routing engine (card 5.1): model name → alias → combo or model → ordered candidate list.
 * No I/O; the index is built once per snapshot.
 */
import type {
  AliasConfig,
  ComboConfig,
  ConfigSnapshot,
  CredentialConfig,
  ModelConfig,
  ProviderConfig,
  UpstreamErrorClass,
  VirtualKeyConfig,
} from '@dirouter/contracts';
import { DEFAULT_FALLBACK_ON } from '@dirouter/contracts';

import type { HealthRegistry } from './health.js';
import { estimateMicroUsd, headroom, RouterStats } from './stats.js';

export interface Candidate {
  model: ModelConfig;
  provider: ProviderConfig;
  credential: CredentialConfig;
}

export interface ResolvedRoute {
  /** The name the client sent. */
  requested: string;
  kind: 'model' | 'combo';
  combo?: ComboConfig;
  candidates: Candidate[];
  fallbackOn: UpstreamErrorClass[];
  /** Targets that were filtered out, and why (for debug logs and the simulator). */
  skipped: { modelId: string; credentialId?: string; reason: string }[];
}

export type RouteError = {
  error:
    'model_not_found' | 'model_not_allowed' | 'no_available_provider' | 'context_length_exceeded';
  /** For context_length_exceeded: required tokens (estimated input + output cap). */
  neededTokens?: number;
  skipped: ResolvedRoute['skipped'];
};

export type Random = () => number;

interface OrgIndex {
  aliases: Map<string, AliasConfig>;
  combos: Map<string, ComboConfig>;
  combosById: Map<string, ComboConfig>;
  models: Map<string, ModelConfig>;
}

export class RouteIndex {
  readonly #orgs = new Map<string, OrgIndex>();
  readonly modelsById = new Map<string, ModelConfig>();
  readonly providersById = new Map<string, ProviderConfig>();

  constructor(snapshot: ConfigSnapshot) {
    const org = (id: string) => {
      let o = this.#orgs.get(id);
      if (!o)
        this.#orgs.set(
          id,
          (o = { aliases: new Map(), combos: new Map(), combosById: new Map(), models: new Map() }),
        );
      return o;
    };
    for (const p of snapshot.providers) this.providersById.set(p.id, p);
    for (const m of snapshot.models) {
      this.modelsById.set(m.id, m);
      org(m.organizationId).models.set(m.slug, m);
    }
    for (const c of snapshot.combos) {
      org(c.organizationId).combos.set(c.slug, c);
      org(c.organizationId).combosById.set(c.id, c);
    }
    for (const a of snapshot.aliases) org(a.organizationId).aliases.set(a.slug, a);
  }

  /** Name → model or combo within the organization's scope. */
  lookup(
    organizationId: string,
    name: string,
  ): { model: ModelConfig } | { combo: ComboConfig } | undefined {
    const o = this.#orgs.get(organizationId);
    if (!o) return undefined;
    const alias = o.aliases.get(name);
    if (alias) {
      if (alias.target.kind === 'model') {
        const model = this.modelsById.get(alias.target.modelId);
        return model ? { model } : undefined;
      }
      const combo = o.combosById.get(alias.target.comboId);
      return combo ? { combo } : undefined;
    }
    const combo = o.combos.get(name);
    if (combo) return { combo };
    const model = o.models.get(name);
    return model ? { model } : undefined;
  }

  /** Display names for /v1/models. */
  names(organizationId: string): string[] {
    const o = this.#orgs.get(organizationId);
    if (!o) return [];
    return [
      ...o.aliases.keys(),
      ...o.combos.keys(),
      ...[...o.models.values()].filter((m) => m.enabled).map((m) => m.slug),
    ];
  }
}

export interface ResolveOptions {
  /** Estimated input tokens for the context window filter. */
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  random?: Random;
  /** Sticky-session identity (card 12.4); usually `key.id` + the client session header. */
  sessionKey?: string;
  /** Stable hash of the prompt prefix; a fallback session identity for sticky combos. */
  promptPrefixHash?: string;
  /** Power-of-two-choices latency selection (card 12.1): samples two candidates, keeps the faster. */
  p2c?: boolean;
  /** Prefer the last successful target of this combo (last-known-good). */
  preferLastKnownGood?: boolean;
}

export interface RouterOptions {
  stats?: RouterStats;
  /** Sticky-session lifetime; 0 disables affinity. */
  affinityTtlMs?: number;
  now?: () => number;
}

/** Weighted random ordering without replacement. */
function weightedOrder<T>(items: T[], weight: (t: T) => number, random: Random): T[] {
  const pool = items.map((item) => ({ item, w: Math.max(0, weight(item)) }));
  const out: T[] = [];
  while (pool.length > 0) {
    const total = pool.reduce((s, p) => s + p.w, 0);
    let pick = 0;
    if (total > 0) {
      let r = random() * total;
      for (; pick < pool.length - 1; pick++) {
        r -= pool[pick]?.w ?? 0;
        if (r < 0) break;
      }
    }
    const [chosen] = pool.splice(pick, 1);
    if (chosen) out.push(chosen.item);
  }
  return out;
}

export class Router {
  readonly #index: RouteIndex;
  readonly #health: HealthRegistry;
  readonly stats: RouterStats;
  readonly #affinityTtlMs: number;
  readonly #now: () => number;
  /** Round-robin counter per (combo, key) — sticky-per-key mode. */
  readonly #rr = new Map<string, number>();
  /** Sticky session → target, for combos with `sticky: true` (card 12.4). */
  readonly #affinity = new Map<
    string,
    { modelId: string; credentialId?: string; expires: number }
  >();

  constructor(index: RouteIndex, health: HealthRegistry, options: RouterOptions = {}) {
    this.#index = index;
    this.#health = health;
    this.stats = options.stats ?? new RouterStats();
    this.#affinityTtlMs = options.affinityTtlMs ?? 3_600_000;
    this.#now = options.now ?? Date.now;
  }

  get index(): RouteIndex {
    return this.#index;
  }

  resolve(
    key: VirtualKeyConfig,
    requested: string,
    options: ResolveOptions = {},
  ): ResolvedRoute | RouteError {
    const random = options.random ?? Math.random;
    const skipped: ResolvedRoute['skipped'] = [];
    if (key.allowedModels.length > 0 && !key.allowedModels.includes(requested))
      return { error: 'model_not_allowed', skipped };

    const found = this.#index.lookup(key.organizationId, requested);
    if (!found) return { error: 'model_not_found', skipped };

    const needed = (options.estimatedInputTokens ?? 0) + (options.maxOutputTokens ?? 0);
    let models: ModelConfig[];
    let combo: ComboConfig | undefined;
    if ('model' in found) {
      models = [found.model];
    } else {
      const c = found.combo;
      combo = c;
      type Target = ComboConfig['targets'][number];
      const targets = c.targets
        .map((t) => ({ t, model: this.#index.modelsById.get(t.modelId) }))
        .filter((x): x is { t: Target; model: ModelConfig } => x.model !== undefined);
      const byOrder = [...targets].sort((a, b) => a.t.order - b.t.order);
      if (c.strategy === 'weighted') {
        models = weightedOrder(byOrder, (x) => x.t.weight, random).map((x) => x.model);
      } else if (c.strategy === 'round-robin') {
        const rrKey = `${c.id}:${key.id}`;
        const n = this.#rr.get(rrKey) ?? 0;
        this.#rr.set(rrKey, n + 1);
        const start = byOrder.length ? n % byOrder.length : 0;
        models = [...byOrder.slice(start), ...byOrder.slice(0, start)].map((x) => x.model);
      } else if (c.strategy === 'latency') {
        if (options.p2c) {
          // P2C: two samples, keep the faster; the rest follow by PeakEWMA.
          const scored = byOrder.map((x) => x.model);
          const winner = this.#pickP2c(scored, random);
          const rest = scored.filter((m) => m.id !== winner?.id);
          models = winner ? [winner, ...orderBy(rest, (m) => latencyKey(this.stats, m.id))] : [];
        } else {
          models = orderBy(
            byOrder.map((x) => x.model),
            (m) => latencyKey(this.stats, m.id),
          );
        }
      } else if (c.strategy === 'cost') {
        models = orderBy(
          byOrder.map((x) => x.model),
          (m) =>
            estimateMicroUsd(m, options.estimatedInputTokens ?? 0, options.maxOutputTokens ?? 0),
        );
      } else if (c.strategy === 'least-used') {
        models = orderBy(
          byOrder.map((x) => x.model),
          (m) => this.stats.recentRequests(m.id) + this.stats.inFlight(m.id),
        );
      } else if (c.strategy === 'headroom') {
        models = orderBy(
          byOrder.map((x) => x.model),
          (m) => -headroom(m, needed),
        );
      } else {
        models = byOrder.map((x) => x.model);
      }
    }

    const candidates: Candidate[] = [];
    for (const model of models) {
      const provider = this.#index.providersById.get(model.providerId);
      if (!model.enabled) {
        skipped.push({ modelId: model.id, reason: 'model_disabled' });
        continue;
      }
      if (!provider?.enabled) {
        skipped.push({ modelId: model.id, reason: 'provider_disabled' });
        continue;
      }
      if (model.contextWindow !== undefined && needed > model.contextWindow) {
        skipped.push({ modelId: model.id, reason: 'context_window' });
        continue;
      }
      if (!this.#health.providerBreaker(provider.id).allow()) {
        skipped.push({ modelId: model.id, reason: 'provider_circuit_open' });
        continue;
      }
      if (!this.#health.modelBreaker(model.id).allow()) {
        skipped.push({ modelId: model.id, reason: 'model_circuit_open' });
        continue;
      }
      const creds = provider.credentials.filter((c) => {
        if (!c.enabled) {
          skipped.push({ modelId: model.id, credentialId: c.id, reason: 'credential_disabled' });
          return false;
        }
        if (!this.#health.credentialAvailable(c.id, model.id)) {
          skipped.push({ modelId: model.id, credentialId: c.id, reason: 'credential_cooldown' });
          return false;
        }
        return true;
      });
      for (const credential of weightedOrder(creds, (c) => c.weight, random))
        candidates.push({ model, provider, credential });
    }

    // Sticky sessions (card 12.4): when the combo asks for affinity, a session keeps its target
    // (model and preferably credential) for the TTL as long as it is healthy. An explicit session
    // header or a stable prompt-prefix hash both work.
    const affinityKey =
      options.sessionKey ?? (options.promptPrefixHash ? options.promptPrefixHash : undefined);
    if (combo?.sticky && affinityKey && this.#affinityTtlMs > 0) {
      const affinityId = `${combo.id}:${affinityKey}`;
      const pinned = this.#affinity.get(affinityId);
      if (pinned && pinned.expires > this.#now()) {
        let at = candidates.findIndex(
          (c) =>
            c.model.id === pinned.modelId &&
            (pinned.credentialId === undefined || c.credential.id === pinned.credentialId),
        );
        // The pinned credential is cooling down: stay on the same model with another credential
        // rather than losing the model affinity as well.
        if (at < 0) at = candidates.findIndex((c) => c.model.id === pinned.modelId);
        if (at > 0) candidates.unshift(...candidates.splice(at, 1));
      } else if (pinned) this.#affinity.delete(affinityId);
    }

    // Last-known-good: after failures, prefer the target that most recently succeeded.
    if (combo && options.preferLastKnownGood && candidates.length > 1) {
      let bestAt = -1;
      let bestIndex = -1;
      candidates.forEach((c, index) => {
        const at = this.stats.lastSuccessAt(c.model.id) ?? -1;
        if (at > bestAt) {
          bestAt = at;
          bestIndex = index;
        }
      });
      if (bestIndex > 0) candidates.unshift(...candidates.splice(bestIndex, 1));
    }

    if (candidates.length === 0) {
      // If no model was removed for health reasons (breaker, cooldown) and at least one was removed
      // only because its context is too small, the problem is the request, not the providers: 400 instead of 503.
      const transient = skipped.some(
        (s) => s.credentialId !== undefined || s.reason.endsWith('circuit_open'),
      );
      if (!transient && skipped.some((s) => s.reason === 'context_window'))
        return { error: 'context_length_exceeded', skipped, neededTokens: needed };
      return { error: 'no_available_provider', skipped };
    }
    return {
      requested,
      kind: combo ? 'combo' : 'model',
      ...(combo ? { combo } : {}),
      candidates,
      fallbackOn: combo?.fallbackOn ?? DEFAULT_FALLBACK_ON,
      skipped,
    };
  }
  /** Remember the successful target of a sticky session; called by the gateway after a success. */
  pinSession(comboId: string, sessionKey: string, modelId: string, credentialId?: string): void {
    if (this.#affinityTtlMs <= 0) return;
    // Prompt-prefix keys are unbounded in number: drop expired pins once the map grows, and the
    // oldest ones if that is not enough (a Map iterates in insertion order).
    if (this.#affinity.size >= 50_000) {
      const now = this.#now();
      for (const [id, entry] of this.#affinity) if (entry.expires <= now) this.#affinity.delete(id);
      for (const id of this.#affinity.keys()) {
        if (this.#affinity.size < 45_000) break;
        this.#affinity.delete(id);
      }
    }
    // Re-inserting moves an active session to the young end of the map.
    this.#affinity.delete(`${comboId}:${sessionKey}`);
    this.#affinity.set(`${comboId}:${sessionKey}`, {
      modelId,
      ...(credentialId ? { credentialId } : {}),
      expires: this.#now() + this.#affinityTtlMs,
    });
  }

  /** Current sticky target of a session (for debug/health). */
  sessionModel(comboId: string, sessionKey: string): string | undefined {
    const entry = this.#affinity.get(`${comboId}:${sessionKey}`);
    if (!entry) return undefined;
    if (entry.expires <= this.#now()) {
      this.#affinity.delete(`${comboId}:${sessionKey}`);
      return undefined;
    }
    return entry.modelId;
  }

  /** Sticky credential, so provider prompt caches stay warm (card 12.4). */
  sessionCredential(comboId: string, sessionKey: string): string | undefined {
    return this.#affinity.get(`${comboId}:${sessionKey}`)?.credentialId;
  }

  /** Power-of-two-choices helper; exported for tests and the dry-run simulator. */
  #pickP2c(models: ModelConfig[], random: Random): ModelConfig | undefined {
    if (models.length <= 2) return orderBy(models, (m) => latencyKey(this.stats, m.id))[0];
    const first = Math.floor(random() * models.length) % models.length;
    let second = Math.floor(random() * models.length) % models.length;
    if (second === first) second = (first + 1) % models.length;
    const a = models[first];
    const b = models[second];
    if (!a || !b) return undefined;
    const score = (m: ModelConfig) =>
      (this.stats.peakLatency(m.id) ?? Number.POSITIVE_INFINITY) * (1 + this.stats.inFlight(m.id));
    return score(a) <= score(b) ? a : b;
  }

  /** Dry-run view of routing for the simulator (card 12.5). */
  simulate(
    key: VirtualKeyConfig,
    requested: string,
    options: ResolveOptions = {},
  ): ResolvedRoute | RouteError {
    return this.resolve(key, requested, options);
  }
}

function orderBy<T>(items: T[], key: (item: T) => number): T[] {
  return [...items].sort((a, b) => key(a) - key(b));
}

/** Unknown models sort last; in-flight pressure raises the score. */
function latencyKey(stats: RouterStats, modelId: string): number {
  const base = stats.peakLatency(modelId) ?? Number.POSITIVE_INFINITY;
  return base * (1 + stats.inFlight(modelId));
}

export function isRouteError(r: ResolvedRoute | RouteError): r is RouteError {
  return 'error' in r;
}
