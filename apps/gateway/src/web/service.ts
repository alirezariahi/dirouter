/**
 * Web search and web fetch as a service (card 30.8).
 *
 * - `POST /v1/search` and `POST /v1/fetch`, behind the virtual key, rate limits, budgets and the
 *   prepaid wallet; each call is its own usage event (`web.search` / `web.fetch`) with its own
 *   price, so search cost shows up separately in usage.
 * - Online mode: a chat request that asks for web search (`web_search_options`, or
 *   `plugins: [{ id: "web" }]`, or the `:online` model suffix through {@link WebServices.serveOnline})
 *   gets search results injected for a model without native search, and the answer carries the
 *   sources (OpenAI `url_citation` annotations; Anthropic `web_search_tool_result` blocks).
 * - Anthropic `web_search` server tool (what Claude Code's WebSearch sends) is run by the gateway
 *   when the model behind the request is not an Anthropic one: the tool becomes a function tool,
 *   the gateway runs the searches the model asks for, and the answer has the same
 *   `server_tool_use` / `web_search_tool_result` blocks the Anthropic API returns.
 *
 * Model calls made here go through the gateway's own endpoints with the caller's key (like the
 * auto-routing classifier), so they are routed, limited, billed and logged as usual.
 */
import { randomBytes } from 'node:crypto';

import {
  type UsageEvent,
  USAGE_EVENT_SCHEMA_VERSION,
  type VirtualKeyConfig,
  WebSearchSettings,
} from '@dirouter/contracts';
import { isAutoAlias, isRouteError, parseModelSuffixes } from '@dirouter/routing';
import { DiRouterError, formatUsd, parseUsd, RateLimitError, ulid } from '@dirouter/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authenticate, extractApiKey } from '../auth.js';
import { errorPayload, handleProxy, type ProxyDeps } from '../proxy.js';
import { budgetScopes, limitScopes } from '../spend-guard.js';
import type { WebSearchExtension } from '../web-search.js';
import { FetchRefused, type FetchedPage, fetchPage } from './fetch.js';
import {
  type SearchAnswer,
  type SearchResult,
  SearchUnavailable,
  type WebSearchBackends,
} from './search.js';

export type OnlineApi = 'openai.chat' | 'anthropic.messages';

const ONE = parseUsd('1');

const SearchBody = z.object({
  query: z.string().trim().min(1).max(400),
  max_results: z.int().min(1).max(20).optional(),
});
const FetchBody = z.object({
  url: z.string().min(1).max(2_048),
  max_bytes: z.int().min(1_024).max(10_485_760).optional(),
});

/** Headers of the client request that the inner model call keeps (auth, tracing, session). */
const DROPPED_INNER_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'accept-encoding',
]);

type Metered<T> =
  | { ok: true; value: T; costUsd: string }
  | { ok: false; error: DiRouterError; headers?: Record<string, string> };

/** The last user message's text, the query of online mode. */
export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role !== 'user') continue;
    const content = message.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part: unknown) => {
          const p = part as { type?: unknown; text?: unknown };
          return (p.type === 'text' || p.type === 'input_text') && typeof p.text === 'string'
            ? p.text
            : '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

/** Search results as a prompt block, numbered so the model can cite `[n]`. */
export function resultsPrompt(query: string, results: readonly SearchResult[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines = results.map(
    (r, i) =>
      `[${String(i + 1)}] ${r.title}\nURL: ${r.url}${r.published ? `\nPublished: ${r.published}` : ''}\n${r.snippet}`,
  );
  return [
    `Web search results for "${query}" (retrieved ${date}):`,
    '',
    lines.join('\n\n'),
    '',
    'Use these results when they help answer the user. Cite each source you use as a markdown link, ' +
      'e.g. [1](https://example.com). Say so if the results do not answer the question.',
  ].join('\n');
}

const isWebSearchServerTool = (tool: unknown) => {
  const t = tool as { type?: unknown; name?: unknown } | undefined;
  return typeof t?.type === 'string' && t.type.startsWith('web_search_');
};

export class WebServices {
  readonly #app: FastifyInstance;
  readonly #deps: ProxyDeps;
  readonly backends: WebSearchBackends;

  constructor(app: FastifyInstance, deps: ProxyDeps, backends: WebSearchBackends) {
    this.#app = app;
    this.#deps = deps;
    this.backends = backends;
  }

  settings(): WebSearchSettings {
    return WebSearchSettings.parse(this.#deps.store.current?.snapshot.settings.webSearch ?? {});
  }

  /** Whether web search can serve now (switched on and at least one backend configured). */
  get available(): boolean {
    const settings = this.settings();
    return settings.enabled && this.backends.available(settings.order).length > 0;
  }

  // ───────────── metering ─────────────

  /**
   * Charges one search or fetch to a key: rate limit (one request), budgets, the wallet, and a
   * usage event of its own (request id `<parent>:web_search:<n>` inside a chat request).
   */
  async #metered<T>(
    kind: 'web.search' | 'web.fetch',
    key: VirtualKeyConfig,
    requestId: string,
    run: () => Promise<{ value: T; label: string; cached?: boolean }>,
  ): Promise<Metered<T>> {
    const deps = this.#deps;
    const config = deps.store.current;
    if (!config)
      return {
        ok: false,
        error: new DiRouterError('service_unavailable', { message: 'not ready' }),
      };
    const started = Date.now();
    const settings = this.settings();
    const price = kind === 'web.search' ? settings.searchPriceUsd : settings.fetchPriceUsd;
    const multiplier = key.priceMultiplier ? parseUsd(key.priceMultiplier) : ONE;
    const listCharge = (parseUsd(price) * multiplier + ONE / 2n) / ONE;

    const admission = deps.limiter
      ? await deps.limiter.acquire(limitScopes(config, key), 0, requestId)
      : undefined;
    if (admission && !admission.ok) {
      deps.metrics?.reject('rate_limit', admission.unavailable ? 'unavailable' : admission.kind);
      return {
        ok: false,
        headers: admission.headers,
        error: new RateLimitError({
          message: `Rate limit exceeded for ${admission.scope.split(':')[0] ?? 'key'} (${admission.kind})`,
          retryAfterMs: admission.retryAfterMs,
        }),
      };
    }
    const budgets = budgetScopes(config, key);
    const budgetCheck = deps.budgets ? await deps.budgets.check(budgets) : { ok: true as const };
    if (!budgetCheck.ok) {
      admission?.settle(0);
      admission?.release();
      deps.metrics?.reject('budget', budgetCheck.unavailable ? 'unavailable' : budgetCheck.kind);
      return {
        ok: false,
        error: new DiRouterError('budget_exceeded', {
          message: `${budgetCheck.period === 'daily' ? 'Daily' : 'Monthly'} ${budgetCheck.scope} budget exceeded`,
        }),
      };
    }
    const walletId = key.walletId;
    if (walletId && deps.wallets) {
      const reservation = await deps.wallets.reserve(walletId, requestId, formatUsd(listCharge));
      if (!reservation.ok) {
        admission?.settle(0);
        admission?.release();
        deps.metrics?.reject('wallet', reservation.unavailable ? 'unavailable' : 'insufficient');
        return {
          ok: false,
          error: new DiRouterError('insufficient_credit', {
            message: `Insufficient credit for a ${kind === 'web.search' ? 'web search' : 'web fetch'}`,
          }),
        };
      }
    }

    let outcome: { value: T; label: string; cached?: boolean } | undefined;
    let failure: DiRouterError | undefined;
    try {
      outcome = await run();
    } catch (error) {
      failure =
        error instanceof FetchRefused
          ? new DiRouterError(error.status === 504 ? 'upstream_timeout' : 'invalid_request', {
              message: error.message,
              status: error.status,
            })
          : error instanceof SearchUnavailable
            ? new DiRouterError('service_unavailable', { message: error.message })
            : new DiRouterError('upstream_error', { message: 'Web request failed' });
      if (error instanceof SearchUnavailable)
        deps.logger.warn({ requestId, failures: error.failures }, 'web search unavailable');
    }
    // A cached answer cost nothing upstream and is not charged.
    const charged = outcome && !outcome.cached ? listCharge : 0n;
    const costUsd = outcome && !outcome.cached ? formatUsd(parseUsd(price)) : '0.00000000';
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: ulid(),
      idempotencyKey: requestId,
      requestId,
      occurredAt: new Date(started).toISOString(),
      gatewayInstance: deps.instance,
      configVersion: config.version,
      organizationId: key.organizationId,
      teamId: key.teamId,
      projectId: key.projectId,
      virtualKeyId: key.id,
      ...(walletId ? { walletId } : {}),
      inboundApi: kind,
      requestedModel: outcome?.label ?? (kind === 'web.search' ? 'web_search' : 'web_fetch'),
      resolvedModelId: null,
      providerId: null,
      credentialId: null,
      stream: false,
      status: outcome ? 'success' : 'error',
      httpStatus: outcome ? 200 : (failure?.status ?? 500),
      ...(failure ? { errorCode: failure.code } : {}),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd,
      chargeUsd: formatUsd(charged),
      usageEstimated: false,
      ...(outcome?.cached ? { cacheHit: true, cacheKind: 'exact' as const } : {}),
      latencyMs: Date.now() - started,
      attempts: [],
    };
    deps.metrics?.observe(event);
    deps.onRequestComplete?.(event);
    deps.emitUsage(event);
    if (walletId) deps.wallets?.settle(walletId, requestId, formatUsd(charged));
    admission?.settle(0);
    admission?.release();
    deps.budgets?.record(budgets, costUsd, 0);
    return outcome
      ? { ok: true, value: outcome.value, costUsd }
      : { ok: false, error: failure ?? new DiRouterError('upstream_error') };
  }

  /**
   * The `:online` model suffix (card 31.5) on top of these searches: the last user message is
   * searched with the caller's own key (rate limit, budgets, wallet and a usage event of its own,
   * like any search) and the results go in front of the system prompt. Without search available
   * the request fails with 400 `web_search_unavailable` instead of answering without it.
   */
  onlineExtension(): WebSearchExtension {
    return {
      available: () => this.available,
      augment: async (request, context) => {
        if (!this.available)
          throw new DiRouterError('web_search_unavailable', {
            message:
              'Web search is not enabled on this gateway, so the :online suffix cannot be served',
            status: 400,
          });
        const key = this.#deps.store.current?.snapshot.virtualKeys.find(
          (k) => k.id === context.virtualKeyId,
        );
        if (!key) throw new DiRouterError('unauthenticated');
        const query = lastUserText(request.messages).slice(0, 400);
        if (!query) return request;
        const found = await this.search(key, query, `${context.requestId}:web_search:1`);
        if (!found.ok) {
          // Limits and money stop the request; a backend failure answers without results.
          if (
            found.error.status === 429 ||
            found.error.code === 'budget_exceeded' ||
            found.error.code === 'insufficient_credit'
          )
            throw found.error;
          return request;
        }
        if (found.value.results.length === 0) return request;
        return {
          ...request,
          system: [
            { type: 'text', text: resultsPrompt(query, found.value.results) },
            ...request.system,
          ],
        };
      },
    };
  }

  /** One metered search for a key (also the building block of online mode). */
  search(
    key: VirtualKeyConfig,
    query: string,
    requestId: string,
    maxResults?: number,
  ): Promise<Metered<SearchAnswer>> {
    const settings = this.settings();
    return this.#metered('web.search', key, requestId, async () => {
      if (!this.available) throw new SearchUnavailable('Web search is not enabled');
      const answer = await this.backends.search(query, {
        order: settings.order,
        max: Math.min(maxResults ?? settings.maxResults, 20),
        cacheTtlSeconds: settings.cacheTtlSeconds,
      });
      return { value: answer, label: `web_search:${answer.backend}`, cached: answer.cached };
    });
  }

  fetch(
    key: VirtualKeyConfig,
    url: string,
    requestId: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ): Promise<Metered<FetchedPage>> {
    const settings = this.settings();
    return this.#metered('web.fetch', key, requestId, async () => {
      if (!settings.enabled) throw new FetchRefused('Web fetch is not enabled', 503);
      const page = await fetchPage(url, {
        maxBytes: Math.min(maxBytes ?? settings.fetchMaxBytes, settings.fetchMaxBytes),
        timeoutMs: settings.fetchTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      return { value: page, label: 'web_fetch' };
    });
  }

  // ───────────── routes ─────────────

  #key(req: FastifyRequest): VirtualKeyConfig {
    const config = this.#deps.store.current;
    if (!config)
      throw new DiRouterError('service_unavailable', {
        message: 'Gateway has no configuration yet',
      });
    return authenticate(
      config,
      extractApiKey(req.headers, (req.query as { key?: string } | undefined)?.key),
      this.#deps.pepper,
      req.ip,
    );
  }

  #fail(
    reply: FastifyReply,
    req: FastifyRequest,
    error: unknown,
    headers?: Record<string, string>,
  ) {
    const e = error instanceof DiRouterError ? error : new DiRouterError('internal_error');
    for (const [name, value] of Object.entries(headers ?? {})) void reply.header(name, value);
    if (e instanceof RateLimitError && e.retryAfterMs !== undefined)
      void reply.header('retry-after', String(Math.ceil(e.retryAfterMs / 1000)));
    return reply.status(e.status).send(errorPayload('openai.chat', e, req.id));
  }

  register(): void {
    this.#app.post('/v1/search', async (req, reply) => {
      let key;
      try {
        key = this.#key(req);
      } catch (error) {
        return this.#fail(reply, req, error);
      }
      const parsed = SearchBody.safeParse(req.body);
      if (!parsed.success)
        return this.#fail(
          reply,
          req,
          new DiRouterError('invalid_request', {
            message: 'query (1 to 400 characters) is required; max_results is 1 to 20',
            param: 'query',
          }),
        );
      const result = await this.search(key, parsed.data.query, req.id, parsed.data.max_results);
      if (!result.ok) return this.#fail(reply, req, result.error, result.headers);
      return {
        object: 'web_search',
        query: parsed.data.query,
        backend: result.value.backend,
        cached: result.value.cached,
        results: result.value.results,
        usage: { searches: 1, cost_usd: result.costUsd },
      };
    });
    this.#app.post('/v1/fetch', async (req, reply) => {
      let key;
      try {
        key = this.#key(req);
      } catch (error) {
        return this.#fail(reply, req, error);
      }
      const parsed = FetchBody.safeParse(req.body);
      if (!parsed.success)
        return this.#fail(
          reply,
          req,
          new DiRouterError('invalid_request', { message: 'url is required', param: 'url' }),
        );
      const gone = new AbortController();
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const result = await this.fetch(
        key,
        parsed.data.url,
        req.id,
        parsed.data.max_bytes,
        gone.signal,
      );
      if (!result.ok) return this.#fail(reply, req, result.error, result.headers);
      const page = result.value;
      return {
        object: 'web_page',
        url: page.url,
        status: page.status,
        content_type: page.contentType,
        ...(page.title ? { title: page.title } : {}),
        content: page.content,
        bytes: page.bytes,
        truncated: page.truncated,
        usage: { fetches: 1, cost_usd: result.costUsd },
      };
    });
  }

  // ───────────── online mode ─────────────

  /** Whether a request asks for web search the gateway has to provide (sync, body only). */
  wants(api: OnlineApi, body: unknown): boolean {
    const b = body as Record<string, unknown> | undefined;
    if (!b) return false;
    if (api === 'openai.chat')
      return (
        b.web_search_options !== undefined ||
        (Array.isArray(b.plugins) &&
          b.plugins.some((p: unknown) => (p as { id?: unknown } | undefined)?.id === 'web'))
      );
    return Array.isArray(b.tools) && b.tools.some(isWebSearchServerTool);
  }

  /**
   * The model name without its `:online` suffix (card 31.5) when the request asks for online mode
   * this way and search can be served, else undefined. Other suffixes stay on the name, and a name
   * that exists as written is never split. Without search the proxy answers 400
   * `web_search_unavailable` itself.
   */
  onlineModel(req: FastifyRequest): string | undefined {
    const model = (req.body as { model?: unknown } | undefined)?.model;
    if (typeof model !== 'string' || !model.includes(':online') || !this.available)
      return undefined;
    const config = this.#deps.store.current;
    if (!config) return undefined;
    // An unauthenticated request goes to the proxy, which answers with the proper error.
    let key: VirtualKeyConfig;
    try {
      key = this.#key(req);
    } catch {
      return undefined;
    }
    const exists = (name: string) =>
      isAutoAlias(name) || config.router.modelsFor(key, name) !== undefined;
    const parsed = parseModelSuffixes(model, exists);
    if (!parsed.webSearch) return undefined;
    const rest = parsed.suffixes.filter((s) => s !== 'online');
    return [parsed.model, ...rest].join(':');
  }

  /** Inner model call through the gateway's own route with the caller's credentials. */
  async #inner(req: FastifyRequest, url: string, payload: Record<string, unknown>, round = 0) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === 'string' && !DROPPED_INNER_HEADERS.has(name)) headers[name] = value;
    headers['content-type'] = 'application/json';
    // The model call is logged under the client's request id; later rounds of a search loop get
    // their own (usage events are idempotent by request id).
    headers['x-request-id'] = round === 0 ? req.id : `${req.id}.r${String(round)}`;
    return this.#app.inject({ method: 'POST', url, headers, payload });
  }

  /**
   * Chat routes call this instead of the proxy when {@link wants} says so. For Anthropic, a
   * request whose model is served by an Anthropic provider keeps the native server tool.
   */
  async handle(api: OnlineApi, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    if (api === 'anthropic.messages') {
      if (this.#nativeAnthropic(req)) return handleProxy(api, req, reply, this.#deps);
      return this.#serverToolLoop(req, reply);
    }
    return this.serveOnline(api, req, reply);
  }

  /** True when the first routed target of the request is an Anthropic provider. */
  #nativeAnthropic(req: FastifyRequest): boolean {
    const config = this.#deps.store.current;
    const model = (req.body as { model?: unknown } | undefined)?.model;
    if (!config || typeof model !== 'string') return true;
    let key;
    try {
      key = this.#key(req);
    } catch {
      // The proxy gives the client the proper authentication error.
      return true;
    }
    const route = config.router.resolve(key, model, {});
    if (isRouteError(route)) return true;
    return route.candidates[0]?.provider.type === 'anthropic';
  }

  /**
   * Online mode: search the last user message, give the results to the model, and return its
   * answer with the sources. `req.body` is the client's request with the model already resolved
   * to its plain name (the `:online` suffix removed by the caller, card 31.5).
   */
  async serveOnline(api: OnlineApi, req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const deps = this.#deps;
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    const plugins = Array.isArray(body.plugins) ? (body.plugins as Record<string, unknown>[]) : [];
    const webPlugin = plugins.find((p) => p.id === 'web');
    const contextSize = (body.web_search_options as { search_context_size?: unknown } | undefined)
      ?.search_context_size;
    delete body.web_search_options;
    if (webPlugin) body.plugins = plugins.filter((p) => p !== webPlugin);
    if (Array.isArray(body.plugins) && body.plugins.length === 0) delete body.plugins;
    if (api === 'anthropic.messages' && Array.isArray(body.tools)) {
      body.tools = (body.tools as unknown[]).filter((t) => !isWebSearchServerTool(t));
      if ((body.tools as unknown[]).length === 0) delete body.tools;
    }
    const maxResults =
      typeof webPlugin?.max_results === 'number'
        ? webPlugin.max_results
        : contextSize === 'low'
          ? 3
          : contextSize === 'high'
            ? 10
            : undefined;

    let key;
    try {
      key = this.#key(req);
    } catch {
      req.body = body;
      return handleProxy(api, req, reply, deps);
    }
    const query = lastUserText(body.messages).slice(0, 400);
    let results: SearchResult[] = [];
    if (query) {
      const found = await this.search(key, query, `${req.id}:web_search:1`, maxResults);
      if (
        !found.ok &&
        (found.error.status === 429 ||
          found.error.code === 'budget_exceeded' ||
          found.error.code === 'insufficient_credit')
      )
        return this.#fail(reply, req, found.error, found.headers);
      if (found.ok) results = found.value.results;
      void reply.header('x-dirouter-web-search', found.ok ? found.value.backend : 'unavailable');
    }
    const stream = body.stream === true;
    const prompt = results.length > 0 ? resultsPrompt(query, results) : undefined;
    if (api === 'openai.chat') {
      const messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];
      if (prompt) messages.unshift({ role: 'system', content: prompt });
      const { stream_options: streamOptions, ...rest } = body;
      const inner = await this.#inner(req, '/v1/chat/completions', {
        ...rest,
        messages,
        stream: false,
      });
      if (inner.statusCode !== 200) return this.#relay(reply, inner);
      const completion = inner.json<Record<string, unknown>>();
      const annotations = results.map((r) => ({
        type: 'url_citation',
        url_citation: {
          url: r.url,
          title: r.title,
          content: r.snippet,
          start_index: 0,
          end_index: 0,
        },
      }));
      for (const choice of (completion.choices as
        { message?: Record<string, unknown> }[] | undefined) ?? [])
        if (choice.message && annotations.length > 0) choice.message.annotations = annotations;
      this.#copyHeaders(reply, inner);
      if (!stream) return reply.send(completion);
      const include =
        (streamOptions as { include_usage?: unknown } | undefined)?.include_usage === true;
      return this.#sse(reply, openAiChunks(completion, include));
    }
    // Anthropic online mode: results in the system prompt, sources as web_search_tool_result.
    const system = body.system;
    const systemWithResults = prompt
      ? typeof system === 'string'
        ? `${prompt}\n\n${system}`
        : Array.isArray(system)
          ? [{ type: 'text', text: prompt }, ...(system as unknown[])]
          : prompt
      : system;
    const inner = await this.#inner(req, '/v1/messages', {
      ...body,
      ...(systemWithResults !== undefined ? { system: systemWithResults } : {}),
      stream: false,
    });
    if (inner.statusCode !== 200) return this.#relay(reply, inner);
    const message = inner.json<Record<string, unknown>>();
    const blocks = results.length > 0 ? searchBlocks(query, results) : [];
    const final = {
      ...message,
      content: [...blocks, ...((message.content as unknown[] | undefined) ?? [])],
      usage: withServerToolUse(message.usage, results.length > 0 ? 1 : 0),
    };
    this.#copyHeaders(reply, inner);
    if (!stream) return reply.send(final);
    return this.#sse(reply, anthropicEvents(final));
  }

  /**
   * Claude Code's `web_search` server tool for a model that has no such tool: the tool becomes a
   * function, and while the model calls it (up to `max_uses`) the gateway searches and answers.
   */
  async #serverToolLoop(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    const tools = (body.tools as Record<string, unknown>[] | undefined) ?? [];
    const serverTool = tools.find(isWebSearchServerTool);
    const maxUses = Math.min(
      typeof serverTool?.max_uses === 'number' ? serverTool.max_uses : 5,
      10,
    );
    const toolName = typeof serverTool?.name === 'string' ? serverTool.name : 'web_search';
    body.tools = [
      ...tools.filter((t) => !isWebSearchServerTool(t)),
      {
        name: toolName,
        description:
          'Search the web for current information. Returns titles, URLs and snippets of matching pages.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      },
    ];
    let key;
    try {
      key = this.#key(req);
    } catch {
      return handleProxy('anthropic.messages', req, reply, this.#deps);
    }
    const stream = body.stream === true;
    const messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];
    const served: unknown[] = [];
    let searches = 0;
    const usage = { input_tokens: 0, output_tokens: 0 };
    let last: Record<string, unknown> | undefined;
    let lastInner;
    for (let round = 0; round <= maxUses; round++) {
      lastInner = await this.#inner(
        req,
        '/v1/messages',
        { ...body, messages, stream: false },
        round,
      );
      if (lastInner.statusCode !== 200) return this.#relay(reply, lastInner);
      last = lastInner.json<Record<string, unknown>>();
      const u = last.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      usage.input_tokens += u?.input_tokens ?? 0;
      usage.output_tokens += u?.output_tokens ?? 0;
      const content = (last.content as Record<string, unknown>[] | undefined) ?? [];
      const calls = content.filter((b) => b.type === 'tool_use' && b.name === toolName);
      const others = content.filter((b) => b.type === 'tool_use' && b.name !== toolName);
      if (calls.length === 0 || searches >= maxUses) break;
      const toolResults: unknown[] = [];
      for (const call of calls) {
        const input = call.input as { query?: unknown } | undefined;
        const query =
          typeof input?.query === 'string' && input.query.trim()
            ? input.query.trim().slice(0, 400)
            : lastUserText(messages).slice(0, 400);
        searches++;
        const found = await this.search(key, query, `${req.id}:web_search:${String(searches)}`);
        if (
          !found.ok &&
          (found.error.status === 429 ||
            found.error.code === 'budget_exceeded' ||
            found.error.code === 'insufficient_credit')
        )
          return this.#fail(reply, req, found.error, found.headers);
        const results = found.ok ? found.value.results : [];
        const id = `srvtoolu_${randomBytes(12).toString('hex')}`;
        served.push(
          { type: 'server_tool_use', id, name: 'web_search', input: { query } },
          {
            type: 'web_search_tool_result',
            tool_use_id: id,
            content: found.ok
              ? results.map(resultBlock)
              : { type: 'web_search_tool_result_error', error_code: 'unavailable' },
          },
        );
        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: results.length > 0 ? resultsPrompt(query, results) : 'No results.',
        });
      }
      // A client tool asked for at the same time ends the loop: the client must run it.
      if (others.length > 0) {
        last = {
          ...last,
          content: content.filter((b) => !(b.type === 'tool_use' && b.name === toolName)),
        };
        break;
      }
      messages.push({ role: 'assistant', content }, { role: 'user', content: toolResults });
    }
    const final = {
      ...(last ?? {}),
      content: [
        ...served,
        ...((last?.content as Record<string, unknown>[] | undefined) ?? []).filter(
          (b) => !(b.type === 'tool_use' && b.name === toolName),
        ),
      ],
      usage: withServerToolUse({ ...(last?.usage as object | undefined), ...usage }, searches),
    };
    if (lastInner) this.#copyHeaders(reply, lastInner);
    if (!stream) return reply.send(final);
    return this.#sse(reply, anthropicEvents(final));
  }

  #copyHeaders(reply: FastifyReply, inner: { headers: Record<string, unknown> }) {
    for (const name of ['x-dirouter-model', 'x-dirouter-provider', 'x-dirouter-instance'])
      if (typeof inner.headers[name] === 'string') void reply.header(name, inner.headers[name]);
  }

  #relay(
    reply: FastifyReply,
    inner: { statusCode: number; headers: Record<string, unknown>; body: string },
  ) {
    for (const name of ['content-type', 'retry-after'])
      if (typeof inner.headers[name] === 'string') void reply.header(name, inner.headers[name]);
    return reply.status(inner.statusCode).send(inner.body);
  }

  #sse(reply: FastifyReply, events: string[]) {
    void reply
      .header('content-type', 'text/event-stream')
      .header('cache-control', 'no-cache')
      .status(200);
    return reply.send(events.join(''));
  }
}

function resultBlock(r: SearchResult) {
  return {
    type: 'web_search_result',
    title: r.title,
    url: r.url,
    // Anthropic sends an opaque blob; here it is the snippet, so a client that shows it has text.
    encrypted_content: Buffer.from(r.snippet).toString('base64'),
    ...(r.published ? { page_age: r.published } : {}),
  };
}

function searchBlocks(query: string, results: readonly SearchResult[]) {
  const id = `srvtoolu_${randomBytes(12).toString('hex')}`;
  return [
    { type: 'server_tool_use', id, name: 'web_search', input: { query } },
    { type: 'web_search_tool_result', tool_use_id: id, content: results.map(resultBlock) },
  ];
}

function withServerToolUse(usage: unknown, searches: number) {
  return {
    ...(usage as object | undefined),
    ...(searches > 0 ? { server_tool_use: { web_search_requests: searches } } : {}),
  };
}

const sse = (event: string | undefined, data: unknown) =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

/** An OpenAI chat completion replayed as a stream (online mode answers in one piece). */
export function openAiChunks(completion: Record<string, unknown>, includeUsage: boolean): string[] {
  const base = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
  };
  const out: string[] = [];
  const choices = (completion.choices as Record<string, unknown>[] | undefined) ?? [];
  for (const choice of choices) {
    const message = (choice.message as Record<string, unknown> | undefined) ?? {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as Record<string, unknown>[]).map((call, index) => ({ index, ...call }))
      : undefined;
    out.push(
      sse(undefined, {
        ...base,
        choices: [
          {
            index: choice.index ?? 0,
            delta: {
              role: 'assistant',
              content: message.content ?? null,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
              ...(message.annotations ? { annotations: message.annotations } : {}),
            },
            finish_reason: null,
          },
        ],
      }),
      sse(undefined, {
        ...base,
        choices: [
          { index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' },
        ],
      }),
    );
  }
  if (includeUsage && completion.usage)
    out.push(sse(undefined, { ...base, choices: [], usage: completion.usage }));
  out.push(sse(undefined, '[DONE]'));
  return out;
}

/** An Anthropic message replayed as the Messages API stream. */
export function anthropicEvents(message: Record<string, unknown>): string[] {
  const content = (message.content as Record<string, unknown>[] | undefined) ?? [];
  const usage = (message.usage as Record<string, unknown> | undefined) ?? {};
  const out = [
    sse('message_start', {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 0 },
      },
    }),
  ];
  content.forEach((block, index) => {
    if (block.type === 'text') {
      out.push(
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        }),
        sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        }),
      );
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      out.push(
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { ...block, input: {} },
        }),
        sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
        }),
      );
    } else {
      out.push(
        sse('content_block_start', { type: 'content_block_start', index, content_block: block }),
      );
    }
    out.push(sse('content_block_stop', { type: 'content_block_stop', index }));
  });
  out.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason ?? 'end_turn', stop_sequence: null },
      usage: {
        output_tokens: usage.output_tokens ?? 0,
        ...(usage.server_tool_use ? { server_tool_use: usage.server_tool_use } : {}),
      },
    }),
    sse('message_stop', { type: 'message_stop' }),
  );
  return out;
}
