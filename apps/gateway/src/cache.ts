/**
 * Exact response cache (card 13.1) and the client for the control-plane semantic cache (card 13.2).
 *
 * Exact cache keys are a hash of the canonical request (model, messages, tools, sampling
 * parameters), so two requests that differ only in headers still share a response. The cache is
 * per replica in memory and optionally in Valkey; an outage degrades to the local cache.
 */
import { createHash } from 'node:crypto';

import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
  CacheSettings,
  ModelConfig,
} from '@dirouter/contracts';

import type { Redis } from 'ioredis';

interface Entry {
  value: string;
  expires: number;
}

export interface ExactCacheOptions {
  redis?: Redis;
  /** Local LRU size. */
  maxEntries?: number;
  now?: () => number;
  /** Prefix so multiple environments can share Valkey. */
  prefix?: string;
}

/** Sampling parameters that make a response reusable (or not). */
export function cacheKeyFor(
  scope: { organizationId: string; projectId: string },
  canonical: CanonicalRequest,
  modelId: string,
): string {
  // The project is part of the key: two projects of one organization never read each other's
  // cached responses, even for byte-identical prompts (card 13.1 isolation).
  const material = JSON.stringify({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    modelId,
    system: canonical.system.map((s) => s.text),
    messages: canonical.messages,
    tools: canonical.tools ?? [],
    toolChoice: canonical.toolChoice ?? null,
    responseFormat: canonical.responseFormat ?? null,
    maxOutputTokens: canonical.maxOutputTokens ?? null,
    temperature: canonical.temperature ?? null,
    topP: canonical.topP ?? null,
    topK: canonical.topK ?? null,
    stop: canonical.stop ?? null,
    seed: canonical.seed ?? null,
    user: canonical.user ?? null,
    // Everything else that changes the answer: reasoning effort, tool-call parallelism and
    // provider-specific pass-through parameters.
    reasoning: canonical.reasoning ?? null,
    parallelToolCalls: canonical.parallelToolCalls ?? null,
    passthrough: canonical.passthrough ?? null,
  });
  return createHash('sha256').update(material).digest('base64url');
}

/**
 * Cacheable only when deterministic enough. Streaming and non-streaming requests share entries:
 * `stream` is not part of the key and a hit is replayed in the client's own stream format.
 */
export function isCacheable(
  canonical: CanonicalRequest,
  settings: CacheSettings | undefined,
): boolean {
  const exact = settings?.exact;
  if (!exact?.enabled) return false;
  if (canonical.temperature !== undefined && canonical.temperature > exact.maxTemperature)
    return false;
  if ((canonical.maxOutputTokens ?? 0) > exact.maxOutputTokens) return false;
  return true;
}

/**
 * Rebuilds a complete response from canonical stream events so a streamed answer can be cached and
 * later replayed (card 13.1). `result()` returns undefined unless the stream finished cleanly.
 */
export class StreamAssembler {
  #id = '';
  #model = '';
  #created = 0;
  #started = false;
  #failed = false;
  #finish:
    { finishReason: CanonicalResponse['finishReason']; rawFinishReason?: string } | undefined;
  #usage: CanonicalResponse['usage'];
  readonly #parts = new Map<
    number,
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string; signature?: string }
    | { type: 'tool_call'; id: string; name: string; arguments: string }
  >();

  push(event: CanonicalStreamEvent): void {
    switch (event.type) {
      case 'start':
        this.#started = true;
        this.#id = event.id;
        this.#model = event.model;
        this.#created = event.created;
        break;
      case 'text_delta': {
        const part = this.#parts.get(event.index);
        if (part?.type === 'text') part.text += event.text;
        else if (!part) this.#parts.set(event.index, { type: 'text', text: event.text });
        else this.#failed = true;
        break;
      }
      case 'reasoning_delta': {
        const part = this.#parts.get(event.index);
        if (part?.type === 'reasoning') {
          part.text += event.text ?? '';
          if (event.signature) part.signature = event.signature;
        } else if (!part)
          this.#parts.set(event.index, {
            type: 'reasoning',
            text: event.text ?? '',
            ...(event.signature ? { signature: event.signature } : {}),
          });
        else this.#failed = true;
        break;
      }
      case 'tool_call_start':
        if (this.#parts.has(event.index)) this.#failed = true;
        else
          this.#parts.set(event.index, {
            type: 'tool_call',
            id: event.id,
            name: event.name,
            arguments: '',
          });
        break;
      case 'tool_call_delta': {
        const part = this.#parts.get(event.index);
        if (part?.type === 'tool_call') part.arguments += event.argumentsDelta;
        else this.#failed = true;
        break;
      }
      case 'usage':
        this.#usage = event.usage;
        break;
      case 'finish':
        this.#finish = {
          finishReason: event.finishReason,
          ...(event.rawFinishReason ? { rawFinishReason: event.rawFinishReason } : {}),
        };
        break;
      case 'error':
        this.#failed = true;
        break;
      case 'content_end':
        break;
    }
  }

  /** The assembled response, or undefined for an incomplete, failed or empty stream. */
  result(usage?: CanonicalResponse['usage']): CanonicalResponse | undefined {
    if (this.#failed || !this.#started || !this.#finish || this.#parts.size === 0) return undefined;
    if (this.#finish.finishReason === 'error' || this.#finish.finishReason === 'content_filter')
      return undefined;
    const content = [...this.#parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part) as CanonicalResponse['content'];
    const finalUsage = this.#usage ?? usage;
    return {
      id: this.#id,
      model: this.#model,
      content,
      ...this.#finish,
      ...(finalUsage ? { usage: finalUsage } : {}),
      created: this.#created,
    };
  }
}

export class ExactCache {
  readonly #local = new Map<string, Entry>();
  readonly #redis: Redis | undefined;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #prefix: string;

  constructor(options: ExactCacheOptions = {}) {
    this.#redis = options.redis;
    this.#maxEntries = options.maxEntries ?? 1_000;
    this.#now = options.now ?? Date.now;
    this.#prefix = options.prefix ?? 'dirouter:cache:exact:';
  }

  async get(key: string): Promise<CanonicalResponse | undefined> {
    const local = this.#local.get(key);
    if (local && local.expires > this.#now()) {
      // Refresh LRU position.
      this.#local.delete(key);
      this.#local.set(key, local);
      return JSON.parse(local.value) as CanonicalResponse;
    }
    if (local) this.#local.delete(key);
    if (!this.#redis) return undefined;
    try {
      const raw = await this.#redis.get(`${this.#prefix}${key}`);
      if (!raw) return undefined;
      return JSON.parse(raw) as CanonicalResponse;
    } catch {
      return undefined;
    }
  }

  async set(key: string, response: CanonicalResponse, ttlSeconds: number): Promise<void> {
    const value = JSON.stringify(response);
    const entry: Entry = { value, expires: this.#now() + ttlSeconds * 1_000 };
    this.#local.delete(key);
    this.#local.set(key, entry);
    while (this.#local.size > this.#maxEntries) {
      const oldest = this.#local.keys().next().value;
      if (oldest === undefined) break;
      this.#local.delete(oldest);
    }
    if (!this.#redis) return;
    try {
      await this.#redis.set(`${this.#prefix}${key}`, value, 'EX', ttlSeconds);
    } catch {
      // Cache write failure is not a request failure.
    }
  }

  stats(): { localEntries: number } {
    return { localEntries: this.#local.size };
  }
}

export interface SemanticSettings {
  threshold: number;
  ttlSeconds: number;
  timeoutMs: number;
  embeddingModel?: string;
}

/**
 * Effective semantic-cache settings of a project (card 13.2): the global block with the project's
 * overrides applied. Undefined when the cache is off for this project.
 */
export function semanticSettingsFor(
  settings: CacheSettings | undefined,
  projectId: string,
): SemanticSettings | undefined {
  const semantic = settings?.semantic;
  if (!semantic) return undefined;
  const project = semantic.projects[projectId];
  if (!(project?.enabled ?? semantic.enabled)) return undefined;
  const embeddingModel = project?.embeddingModel ?? semantic.embeddingModel;
  return {
    threshold: project?.threshold ?? semantic.threshold,
    ttlSeconds: semantic.ttlSeconds,
    timeoutMs: semantic.timeoutMs,
    ...(embeddingModel ? { embeddingModel } : {}),
  };
}

/**
 * Semantic matching compares only the system prompt and the user's text, so it is safe only when
 * that is the whole request: a single text-only user turn and no tools. In a multi-turn or tool
 * conversation the same last message ("yes", "continue") means something different every time, and
 * a "similar" cached answer would be wrong.
 */
export function isSemanticCacheable(canonical: CanonicalRequest): boolean {
  if (canonical.tools && canonical.tools.length > 0) return false;
  if (canonical.responseFormat && canonical.responseFormat.type !== 'text') return false;
  const [only, ...rest] = canonical.messages;
  if (!only || rest.length > 0 || only.role !== 'user') return false;
  return only.content.length > 0 && only.content.every((part) => part.type === 'text');
}

export interface SemanticCacheHit {
  response: CanonicalResponse;
  similarity: number;
  modelId: string;
}

/**
 * Fail-open client for the pgvector semantic cache in control-api. The gateway never waits longer
 * than `timeoutMs`; any error, timeout or non-2xx is a miss.
 */
export class SemanticCacheClient {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl: string; internalToken: string; fetchImpl?: typeof fetch }) {
    this.#url = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.internalToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async lookup(input: {
    organizationId: string;
    projectId: string;
    embeddingModel?: string;
    model: string;
    texts: string;
    threshold: number;
    timeoutMs: number;
  }): Promise<SemanticCacheHit | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, input.timeoutMs);
    try {
      const res = await this.#fetch(`${this.#url}/internal/semantic-cache/query`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#token}`,
        },
        body: JSON.stringify({
          organizationId: input.organizationId,
          projectId: input.projectId,
          ...(input.embeddingModel ? { embeddingModel: input.embeddingModel } : {}),
          model: input.model,
          text: input.texts,
          threshold: input.threshold,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as {
        hit?: boolean;
        similarity?: number;
        modelId?: string;
        response?: unknown;
      };
      if (!json.hit || !json.response) return undefined;
      return {
        response: json.response as CanonicalResponse,
        similarity: json.similarity ?? 0,
        modelId: json.modelId ?? input.model,
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async store(input: {
    organizationId: string;
    projectId: string;
    embeddingModel?: string;
    modelId: string;
    model: string;
    text: string;
    response: CanonicalResponse;
    ttlSeconds: number;
  }): Promise<void> {
    try {
      await this.#fetch(`${this.#url}/internal/semantic-cache/store`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#token}`,
        },
        body: JSON.stringify(input),
      });
    } catch {
      // Best effort.
    }
  }
}

/** Prompt text used for semantic similarity (system + the last user message). */
export function semanticText(canonical: CanonicalRequest): string {
  const system = canonical.system.map((s) => s.text).join('\n');
  const lastUser = [...canonical.messages]
    .reverse()
    .find((m) => m.role === 'user')
    ?.content.map((p) => (p.type === 'text' ? p.text : ''))
    .join('\n');
  return `${system}\n${lastUser ?? ''}`.trim();
}

/** Rough token estimate for embeddings cost accounting. */
export function embeddingsCostModel(model: ModelConfig | undefined): ModelConfig | undefined {
  return model?.capabilities.embeddings ? model : undefined;
}
