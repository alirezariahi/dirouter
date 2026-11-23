/**
 * Client side of an upstream MCP server (card 20.1), for both HTTP transports:
 *
 * - Streamable HTTP (2025-03-26 and later): every message is a POST; the answer is JSON or an SSE
 *   stream carrying the response. The server may issue an `Mcp-Session-Id` at initialization, which
 *   is then sent on every request; a 404 means the session expired and the client starts again.
 * - HTTP+SSE (2024-11-05): a long-lived GET stream first announces a POST endpoint (`endpoint`
 *   event); requests are POSTed there and their responses arrive on the stream.
 *
 * One connection is kept per server and gateway replica and initialized lazily.
 */
import type { Logger } from '@dirouter/shared';

export const CLIENT_PROTOCOL = '2025-06-18';
const CLIENT_INFO = { name: 'dirouter-gateway', version: '1.0.0' };

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpUpstreamError extends Error {
  constructor(
    message: string,
    readonly code = -32603,
  ) {
    super(message);
    this.name = 'McpUpstreamError';
  }
}

export interface UpstreamTarget {
  url: string;
  transport: 'streamable-http' | 'sse';
  headers: Record<string, string>;
  timeoutMs: number;
}

/** Reads `data:` payloads of an SSE body one event at a time. */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value.replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length > 0) yield { event, data: data.join('\n') };
    }
  }
}

export class McpUpstream {
  #nextId = 1;
  #session: string | undefined;
  #initialized: Promise<void> | undefined;
  // HTTP+SSE transport state.
  #postUrl: string | undefined;
  #stream: AbortController | undefined;
  readonly #pending = new Map<string | number, (response: JsonRpcResponse) => void>();

  constructor(
    readonly target: UpstreamTarget,
    private readonly logger: Logger,
  ) {}

  /** Sends a request and returns its result; JSON-RPC errors become McpUpstreamError. */
  async request(method: string, params: unknown, extraHeaders: Record<string, string> = {}) {
    await this.#ensureInitialized();
    let response: JsonRpcResponse;
    try {
      response = await this.#send(method, params, extraHeaders);
    } catch (error) {
      // Expired session: start over once.
      if (!(error instanceof SessionExpired)) throw error;
      this.reset();
      await this.#ensureInitialized();
      response = await this.#send(method, params, extraHeaders);
    }
    if (response.error) throw new McpUpstreamError(response.error.message, response.error.code);
    return response.result;
  }

  reset(): void {
    this.#session = undefined;
    this.#initialized = undefined;
    this.#postUrl = undefined;
    this.#stream?.abort();
    this.#stream = undefined;
    for (const resolve of this.#pending.values())
      resolve({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'connection reset' } });
    this.#pending.clear();
  }

  #ensureInitialized(): Promise<void> {
    this.#initialized ??= this.#initialize().catch((error: unknown) => {
      this.#initialized = undefined;
      throw error;
    });
    return this.#initialized;
  }

  async #initialize(): Promise<void> {
    if (this.target.transport === 'sse') await this.#openStream();
    const response = await this.#send('initialize', {
      protocolVersion: CLIENT_PROTOCOL,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    if (response.error)
      throw new McpUpstreamError(
        `initialize failed: ${response.error.message}`,
        response.error.code,
      );
    await this.#notify('notifications/initialized');
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': CLIENT_PROTOCOL,
      ...this.target.headers,
      ...(this.#session ? { 'mcp-session-id': this.#session } : {}),
      ...extra,
    };
  }

  async #notify(method: string): Promise<void> {
    const url = this.target.transport === 'sse' ? this.#postUrl : this.target.url;
    if (!url) throw new McpUpstreamError('no message endpoint');
    const res = await fetch(url, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      signal: AbortSignal.timeout(this.target.timeoutMs),
    });
    await res.body?.cancel();
  }

  async #send(
    method: string,
    params: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonRpcResponse> {
    const id = this.#nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (this.target.transport === 'sse') return this.#sendOverStream(id, body, extraHeaders);

    let res: Response;
    try {
      res = await fetch(this.target.url, {
        method: 'POST',
        headers: this.#headers(extraHeaders),
        body,
        signal: AbortSignal.timeout(this.target.timeoutMs),
      });
    } catch (error) {
      throw new McpUpstreamError(
        `upstream unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (res.status === 404 && this.#session && method !== 'initialize') {
      await res.body?.cancel();
      throw new SessionExpired();
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new McpUpstreamError(`upstream answered HTTP ${String(res.status)}: ${text}`);
    }
    const session = res.headers.get('mcp-session-id');
    if (method === 'initialize' && session) this.#session = session;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      for await (const event of sseEvents(res.body)) {
        const message = JSON.parse(event.data) as JsonRpcResponse;
        if (message.id === id) {
          await res.body.cancel().catch(() => undefined);
          return message;
        }
      }
      throw new McpUpstreamError('stream ended without a response');
    }
    return (await res.json()) as JsonRpcResponse;
  }

  // ───────────── HTTP+SSE (2024-11-05) ─────────────

  async #openStream(): Promise<void> {
    const controller = new AbortController();
    this.#stream = controller;
    const res = await fetch(this.target.url, {
      headers: { accept: 'text/event-stream', ...this.target.headers },
      signal: controller.signal,
    });
    if (!res.ok || !res.body)
      throw new McpUpstreamError(`SSE stream refused (HTTP ${String(res.status)})`);
    const events = sseEvents(res.body);
    const first = await events.next();
    if (first.done || first.value.event !== 'endpoint')
      throw new McpUpstreamError('SSE stream did not announce an endpoint');
    this.#postUrl = new URL(first.value.data, this.target.url).toString();
    // The rest of the stream carries responses, matched to waiting requests by id.
    void (async () => {
      try {
        for await (const event of events) {
          if (event.event !== 'message') continue;
          const message = JSON.parse(event.data) as JsonRpcResponse;
          if (message.id === null) continue;
          this.#pending.get(message.id)?.(message);
          this.#pending.delete(message.id);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          this.logger.warn({ err: error, url: this.target.url }, 'MCP SSE stream failed');
      } finally {
        // Next request reconnects.
        if (this.#stream === controller) this.reset();
      }
    })();
  }

  async #sendOverStream(
    id: number,
    body: string,
    extraHeaders: Record<string, string>,
  ): Promise<JsonRpcResponse> {
    const url = this.#postUrl;
    if (!url) throw new McpUpstreamError('no message endpoint');
    const answer = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new McpUpstreamError('upstream did not answer in time'));
      }, this.target.timeoutMs);
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: this.#headers(extraHeaders),
      body,
      signal: AbortSignal.timeout(this.target.timeoutMs),
    }).catch((error: unknown) => {
      this.#pending.delete(id);
      throw new McpUpstreamError(
        `upstream unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
    });
    await res.body?.cancel();
    if (!res.ok) {
      this.#pending.delete(id);
      throw new McpUpstreamError(`upstream answered HTTP ${String(res.status)}`);
    }
    return answer;
  }
}

class SessionExpired extends Error {}
