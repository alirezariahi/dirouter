/**
 * Web search backends (card 30.8): SearXNG (self-hosted), Brave Search and Tavily behind one
 * interface, tried in the configured order with fallback, and a result cache (Valkey when there
 * is one, otherwise in memory).
 *
 * Backend addresses and API keys come from the gateway environment (operator configuration), so
 * these calls do not go through the tenant SSRF guard; a self-hosted SearXNG is usually private.
 */
import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

export type SearchBackendName = 'searxng' | 'brave' | 'tavily';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Publication date or age as the backend gives it, when it does. */
  published?: string;
}

export interface SearchBackendConfig {
  /** SearXNG base URL (the instance must allow `format=json`). */
  searxngUrl?: string | undefined;
  braveApiKey?: string | undefined;
  braveUrl?: string | undefined;
  tavilyApiKey?: string | undefined;
  tavilyUrl?: string | undefined;
  /** Per backend call; the next backend is tried after it. */
  timeoutMs?: number | undefined;
}

export interface SearchAnswer {
  backend: SearchBackendName;
  results: SearchResult[];
  cached: boolean;
}

export class SearchUnavailable extends Error {
  constructor(
    message: string,
    readonly failures: { backend: SearchBackendName; error: string }[] = [],
  ) {
    super(message);
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const MAX_SNIPPET = 1_000;

function clean(results: SearchResult[], max: number): SearchResult[] {
  return results
    .filter((r) => /^https?:\/\//i.test(r.url))
    .slice(0, max)
    .map((r) => ({
      title: r.title.slice(0, 300),
      url: r.url.slice(0, 2_048),
      snippet: r.snippet.replace(/<[^>]+>/g, '').slice(0, MAX_SNIPPET),
      ...(r.published ? { published: r.published.slice(0, 64) } : {}),
    }));
}

type Backend = (query: string, max: number, signal: AbortSignal) => Promise<SearchResult[]>;

async function json(response: Response, backend: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${backend} answered ${String(response.status)}`);
  return (await response.json()) as Record<string, unknown>;
}

function backends(config: SearchBackendConfig): Partial<Record<SearchBackendName, Backend>> {
  const out: Partial<Record<SearchBackendName, Backend>> = {};
  if (config.searxngUrl) {
    const base = trimSlash(config.searxngUrl);
    out.searxng = async (query, max, signal) => {
      const url = `${base}/search?${new URLSearchParams({ q: query, format: 'json' }).toString()}`;
      const body = await json(await fetch(url, { signal }), 'searxng');
      const rows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
      return clean(
        rows.map((r) => ({
          title: str(r.title),
          url: str(r.url),
          snippet: str(r.content),
          published: str(r.publishedDate),
        })),
        max,
      );
    };
  }
  if (config.braveApiKey) {
    const base = trimSlash(config.braveUrl ?? 'https://api.search.brave.com');
    const key = config.braveApiKey;
    out.brave = async (query, max, signal) => {
      const params = new URLSearchParams({ q: query, count: String(max) });
      const body = await json(
        await fetch(`${base}/res/v1/web/search?${params.toString()}`, {
          headers: { accept: 'application/json', 'x-subscription-token': key },
          signal,
        }),
        'brave',
      );
      const web = body.web as { results?: Record<string, unknown>[] } | undefined;
      return clean(
        (web?.results ?? []).map((r) => ({
          title: str(r.title),
          url: str(r.url),
          snippet: str(r.description),
          published: str(r.page_age) || str(r.age),
        })),
        max,
      );
    };
  }
  if (config.tavilyApiKey) {
    const base = trimSlash(config.tavilyUrl ?? 'https://api.tavily.com');
    const key = config.tavilyApiKey;
    out.tavily = async (query, max, signal) => {
      const body = await json(
        await fetch(`${base}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ query, max_results: max }),
          signal,
        }),
        'tavily',
      );
      const rows = Array.isArray(body.results) ? (body.results as Record<string, unknown>[]) : [];
      return clean(
        rows.map((r) => ({
          title: str(r.title),
          url: str(r.url),
          snippet: str(r.content),
          published: str(r.published_date),
        })),
        max,
      );
    };
  }
  return out;
}

const CACHE_PREFIX = 'dirouter:websearch:';
const LOCAL_CACHE_MAX = 500;

export class WebSearchBackends {
  readonly #backends: Partial<Record<SearchBackendName, Backend>>;
  readonly #timeoutMs: number;
  readonly #redis: Pick<Redis, 'get' | 'set'> | undefined;
  readonly #local = new Map<string, { until: number; answer: Omit<SearchAnswer, 'cached'> }>();

  constructor(config: SearchBackendConfig, redis?: Pick<Redis, 'get' | 'set'>) {
    this.#backends = backends(config);
    this.#timeoutMs = config.timeoutMs ?? 8_000;
    this.#redis = redis;
  }

  /** Backends that have configuration, in the given order. */
  available(order: readonly SearchBackendName[]): SearchBackendName[] {
    return order.filter((name) => this.#backends[name] !== undefined);
  }

  get configured(): boolean {
    return Object.keys(this.#backends).length > 0;
  }

  async search(
    query: string,
    options: { order: readonly SearchBackendName[]; max: number; cacheTtlSeconds: number },
  ): Promise<SearchAnswer> {
    const normalized = query.trim().replace(/\s+/g, ' ');
    const cacheKey = `${CACHE_PREFIX}${createHash('sha256')
      .update(`${String(options.max)}\n${normalized.toLowerCase()}`)
      .digest('hex')}`;
    if (options.cacheTtlSeconds > 0) {
      const hit = await this.#cacheGet(cacheKey);
      if (hit) return { ...hit, cached: true };
    }
    const failures: { backend: SearchBackendName; error: string }[] = [];
    for (const name of this.available(options.order)) {
      const backend = this.#backends[name];
      if (!backend) continue;
      try {
        const results = await backend(
          normalized,
          options.max,
          AbortSignal.timeout(this.#timeoutMs),
        );
        const answer = { backend: name, results };
        if (options.cacheTtlSeconds > 0)
          await this.#cacheSet(cacheKey, answer, options.cacheTtlSeconds);
        return { ...answer, cached: false };
      } catch (error) {
        failures.push({ backend: name, error: error instanceof Error ? error.message : 'failed' });
      }
    }
    throw new SearchUnavailable(
      failures.length > 0
        ? 'Every web search backend failed'
        : 'No web search backend is configured',
      failures,
    );
  }

  async #cacheGet(key: string): Promise<Omit<SearchAnswer, 'cached'> | undefined> {
    if (this.#redis) {
      try {
        const raw = await this.#redis.get(key);
        return raw ? (JSON.parse(raw) as Omit<SearchAnswer, 'cached'>) : undefined;
      } catch {
        // A Valkey problem is a cache miss.
      }
    }
    const local = this.#local.get(key);
    if (local && local.until > Date.now()) return local.answer;
    this.#local.delete(key);
    return undefined;
  }

  async #cacheSet(key: string, answer: Omit<SearchAnswer, 'cached'>, ttl: number): Promise<void> {
    if (this.#redis) {
      try {
        await this.#redis.set(key, JSON.stringify(answer), 'EX', ttl);
        return;
      } catch {
        // Fall back to the local cache.
      }
    }
    if (this.#local.size >= LOCAL_CACHE_MAX) {
      const oldest = this.#local.keys().next().value;
      if (oldest !== undefined) this.#local.delete(oldest);
    }
    this.#local.set(key, { until: Date.now() + ttl * 1_000, answer });
  }
}
