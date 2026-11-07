/**
 * موتور مسیریابی (کارت ۵.۱): نام مدل ← alias ← combo یا مدل ← فهرست مرتب کاندیداها.
 * بدون I/O؛ index یک بار به ازای هر snapshot ساخته می‌شود.
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

export interface Candidate {
  model: ModelConfig;
  provider: ProviderConfig;
  credential: CredentialConfig;
}

export interface ResolvedRoute {
  /** نامی که کلاینت فرستاد. */
  requested: string;
  kind: 'model' | 'combo';
  combo?: ComboConfig;
  candidates: Candidate[];
  fallbackOn: UpstreamErrorClass[];
  /** هدف‌هایی که فیلتر شدند و دلیلشان (برای لاگ debug و شبیه‌ساز). */
  skipped: { modelId: string; credentialId?: string; reason: string }[];
}

export type RouteError = {
  error: 'model_not_found' | 'model_not_allowed' | 'no_available_provider';
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

  /** نام → مدل یا combo در محدودهٔ سازمان. */
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

  /** نام‌های قابل‌نمایش برای /v1/models. */
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
  /** تخمین توکن ورودی برای فیلتر context window. */
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  random?: Random;
}

/** ترتیب تصادفی وزنی بدون جایگذاری. */
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
  /** شمارندهٔ round-robin به ازای (combo، کلید) — حالت sticky per key. */
  readonly #rr = new Map<string, number>();

  constructor(index: RouteIndex, health: HealthRegistry) {
    this.#index = index;
    this.#health = health;
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
      } else {
        models = byOrder.map((x) => x.model);
      }
    }

    const needed = (options.estimatedInputTokens ?? 0) + (options.maxOutputTokens ?? 0);
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

    if (candidates.length === 0) return { error: 'no_available_provider', skipped };
    return {
      requested,
      kind: combo ? 'combo' : 'model',
      ...(combo ? { combo } : {}),
      candidates,
      fallbackOn: combo?.fallbackOn ?? DEFAULT_FALLBACK_ON,
      skipped,
    };
  }
}

export function isRouteError(r: ResolvedRoute | RouteError): r is RouteError {
  return 'error' in r;
}
