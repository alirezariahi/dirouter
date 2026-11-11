/**
 * Upstream calls with multi-layer timeouts (card 5.4) and outbound proxy (card 4.10).
 *
 * - connect: per provider in the undici Agent
 * - firstByte (TTFT): until the response headers arrive (and for streams, until the first chunk)
 * - idle: silence between two chunks in the stream
 * - total: overall deadline for the attempt
 * All timeouts are passed to upstream via AbortController.
 */
import { lookup } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';

import type { ProviderConfig, TimeoutConfig } from '@dirouter/contracts';
import type { UpstreamRequest } from '@dirouter/providers';
import { SocksClient } from 'socks';
import { Agent, type buildConnector, type Dispatcher, ProxyAgent, fetch } from 'undici';

export type TimeoutKind = 'connect' | 'first_byte' | 'idle' | 'total';

export class UpstreamTimeout extends Error {
  override readonly name = 'UpstreamTimeout';
  constructor(readonly kind: TimeoutKind) {
    super(`upstream ${kind} timeout`);
  }
}

export const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  connectMs: 5_000,
  firstByteMs: 60_000,
  idleMs: 60_000,
  totalMs: 600_000,
};

export function mergeTimeouts(...layers: (TimeoutConfig | undefined)[]): Required<TimeoutConfig> {
  const merged: Required<TimeoutConfig> = { ...DEFAULT_TIMEOUTS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const k of ['connectMs', 'firstByteMs', 'idleMs', 'totalMs'] as const) {
      const v = layer[k];
      if (v !== undefined) merged[k] = v;
    }
  }
  return merged;
}

const dispatchers = new Map<string, Dispatcher>();

/** One dispatcher (connection pool) per provider; connection bulkheads are separate. */
/** The proxy password never appears in logs or errors: `socks5://user:***@host:1080`. */
export function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '[invalid proxy url]';
  }
}

/**
 * Connects via SOCKS5. With `socks5h://` the hostname is handed to the proxy itself (DNS
 * resolved on the proxy side, useful when local DNS is filtered). With `socks5://` the name is resolved locally first.
 */
function socksConnector(proxyUrl: string, timeoutMs: number): buildConnector.connector {
  const proxy = new URL(proxyUrl);
  const remoteDns = proxy.protocol === 'socks5h:';
  return (opts, callback) => {
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    const target = remoteDns
      ? Promise.resolve(opts.hostname)
      : lookup(opts.hostname).then((r) => r.address);
    target
      .then((host) =>
        SocksClient.createConnection({
          proxy: {
            host: proxy.hostname,
            port: Number(proxy.port) || 1080,
            type: 5,
            ...(proxy.username ? { userId: decodeURIComponent(proxy.username) } : {}),
            ...(proxy.password ? { password: decodeURIComponent(proxy.password) } : {}),
          },
          command: 'connect',
          destination: { host, port },
          timeout: timeoutMs,
        }),
      )
      .then(({ socket }) => {
        if (opts.protocol !== 'https:') {
          callback(null, socket);
          return;
        }
        const secure = tlsConnect({
          socket,
          servername: opts.servername ?? opts.hostname,
          ALPNProtocols: ['http/1.1'],
        });
        secure.once('secureConnect', () => {
          callback(null, secure);
        });
        secure.once('error', (error: Error) => {
          callback(error, null);
        });
      })
      .catch((error: unknown) => {
        // The socks error message sometimes contains the proxy address; only the masked version is emitted.
        const message = error instanceof Error ? error.message : String(error);
        const wrapped = Object.assign(
          new Error(
            `socks proxy ${maskProxyUrl(proxyUrl)}: ${message.replaceAll(proxyUrl, maskProxyUrl(proxyUrl))}`,
          ),
          { code: 'ECONNREFUSED' },
        );
        callback(wrapped, null);
      });
  };
}

/**
 * One dispatcher per (provider, proxy, connect timeout); keep-alive connections stay separate
 * so a slow provider cannot starve the others. Proxy: HTTP(S) with ProxyAgent
 * (CONNECT), and SOCKS5/SOCKS5h with a custom connector.
 */
export function dispatcherFor(
  provider: ProviderConfig,
  connectMs: number,
  proxyUrl: string | undefined = provider.proxy?.url,
): Dispatcher {
  const cacheKey = `${provider.id}|${String(connectMs)}|${proxyUrl ?? ''}`;
  let d = dispatchers.get(cacheKey);
  if (!d) {
    const common = {
      connect: { timeout: connectMs },
      keepAliveTimeout: 30_000,
      connections: provider.maxConcurrency ?? 256,
    };
    if (!proxyUrl) d = new Agent(common);
    else if (/^https?:/.test(proxyUrl)) d = new ProxyAgent({ uri: proxyUrl, ...common });
    else if (/^socks5h?:/.test(proxyUrl))
      d = new Agent({ ...common, connect: socksConnector(proxyUrl, connectMs) });
    else throw new Error(`unsupported proxy scheme: ${maskProxyUrl(proxyUrl)}`);
    dispatchers.set(cacheKey, d);
  }
  return d;
}

export interface UpstreamCall {
  response: Awaited<ReturnType<typeof fetch>>;
  /** Clears timers after the work finishes. */
  done(): void;
  /** Restarts the silence timer (on every chunk). */
  touch(): void;
  signal: AbortSignal;
}

/**
 * Sends the request. `stream` determines whether the TTFT timer continues past the headers until the first chunk
 * and whether idle is enabled.
 */
export async function callUpstream(
  provider: ProviderConfig,
  up: UpstreamRequest,
  timeouts: Required<TimeoutConfig>,
  parent: AbortSignal,
  stream: boolean,
  /** Final proxy (credential, then provider, then global); defaults to the provider's proxy. */
  proxyUrl: string | undefined = provider.proxy?.url,
): Promise<UpstreamCall> {
  const controller = new AbortController();
  let reason: TimeoutKind | undefined;
  const abortFor = (kind: TimeoutKind) => () => {
    reason = kind;
    controller.abort(new UpstreamTimeout(kind));
  };
  const onParent = () => {
    controller.abort(parent.reason);
  };
  if (parent.aborted) onParent();
  parent.addEventListener('abort', onParent, { once: true });

  const total = setTimeout(abortFor('total'), timeouts.totalMs);
  // For non-stream, the model builds the whole response; TTFT only makes sense for streams.
  let firstByte: NodeJS.Timeout | undefined = stream
    ? setTimeout(abortFor('first_byte'), timeouts.firstByteMs)
    : undefined;
  let idle: NodeJS.Timeout | undefined;

  const done = () => {
    clearTimeout(total);
    clearTimeout(firstByte);
    clearTimeout(idle);
    parent.removeEventListener('abort', onParent);
  };

  try {
    const response = await fetch(up.url, {
      method: up.method,
      headers: up.headers,
      ...(up.body !== undefined ? { body: up.body } : {}),
      signal: controller.signal,
      dispatcher: dispatcherFor(provider, timeouts.connectMs, proxyUrl),
    });
    return {
      response,
      done,
      signal: controller.signal,
      touch: () => {
        if (!stream) return;
        clearTimeout(firstByte);
        firstByte = undefined;
        clearTimeout(idle);
        idle = setTimeout(abortFor('idle'), timeouts.idleMs);
      },
    };
  } catch (error) {
    done();
    if (reason) throw new UpstreamTimeout(reason);
    throw error;
  }
}

/** Error body text with a size cap (so a large error response does not fill memory). */
export async function readErrorBody(
  response: Awaited<ReturnType<typeof fetch>>,
  limit = 16_384,
): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, limit);
  } catch {
    return '';
  }
}
