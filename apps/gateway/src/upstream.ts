/**
 * Upstream calls with multi-layer timeouts (card 5.4) and outbound proxy (card 4.10).
 *
 * - connect: per provider in the undici Agent
 * - firstByte (TTFT): until the response headers arrive (and for streams, until the first chunk)
 * - idle: silence between two chunks in the stream
 * - total: overall deadline for the attempt
 * All timeouts are passed to upstream via AbortController.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import type { ProviderConfig, TimeoutConfig } from '@dirouter/contracts';
import type { UpstreamRequest } from '@dirouter/providers';
import { isBlockedAddress } from '@dirouter/shared';
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
// ───────────── SSRF guard (card 22.3) ─────────────

/**
 * In production, providers of customer organizations may only reach public addresses; the
 * platform organization may use private ones (self-hosted models). Checked when connecting, so a
 * name that resolves differently later (DNS rebinding) is caught too.
 */
const guard: { enabled: boolean; platformOrganizationId: () => string | undefined } = {
  enabled: false,
  platformOrganizationId: () => undefined,
};

export function configureUpstreamGuard(options: {
  enabled: boolean;
  platformOrganizationId: () => string | undefined;
}): void {
  guard.enabled = options.enabled;
  guard.platformOrganizationId = options.platformOrganizationId;
}

/** Whether the SSRF guard applies to addresses this organization supplies. */
export const guardedOrganization = (organizationId: string) =>
  guard.enabled && organizationId !== guard.platformOrganizationId();

const guarded = (provider: ProviderConfig) => guardedOrganization(provider.organizationId);

export class UpstreamBlocked extends Error {
  readonly code = 'EBLOCKED';
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** `dns.lookup` that refuses names resolving to private, loopback or link-local addresses. */
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const list = addresses;
    if (list.length === 0 || list.some((a) => isBlockedAddress(a.address))) {
      callback(new UpstreamBlocked(`${hostname} resolves to a non-public address`), []);
      return;
    }
    const first = list[0] as LookupAddress;
    if (options.all) callback(null, list);
    else callback(null, first.address, first.family);
  });
}

let publicOnlyAgent: Agent | undefined;

/**
 * `fetch` for addresses a tenant supplies outside the provider list: OAuth endpoints found in an
 * MCP server's metadata (card 28.1) and A2A push-notification webhooks (card 28.2). With the guard
 * on, customer organizations reach public addresses only, checked when connecting (DNS rebinding)
 * and for IP literals here. Redirects are never followed.
 */
export function tenantFetch(
  organizationId: string,
): (url: string, init?: RequestInit) => Promise<Response> {
  if (!guardedOrganization(organizationId))
    return (url, init) => globalThis.fetch(url, { ...init, redirect: 'manual' });
  const connect = { timeout: 10_000, lookup: publicOnlyLookup };
  publicOnlyAgent ??= new Agent({ connect });
  const agent = publicOnlyAgent;
  return async (url, init) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && isBlockedAddress(host))
      throw new UpstreamBlocked(`${host} is not a public address`);
    const res = await fetch(url, {
      ...(init as Parameters<typeof fetch>[1]),
      redirect: 'manual',
      dispatcher: agent,
    });
    return res as unknown as Response;
  };
}

export function dispatcherFor(
  provider: ProviderConfig,
  connectMs: number,
  proxyUrl: string | undefined = provider.proxy?.url,
): Dispatcher {
  const publicOnly = guarded(provider);
  const cacheKey = `${provider.id}|${String(connectMs)}|${proxyUrl ?? ''}|${String(publicOnly)}`;
  let d = dispatchers.get(cacheKey);
  if (!d) {
    const common = {
      connect: { timeout: connectMs, ...(publicOnly ? { lookup: publicOnlyLookup } : {}) },
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
    // IP literals skip DNS, so the guard checks them here.
    if (guarded(provider)) {
      const host = new URL(up.url).hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) !== 0 && isBlockedAddress(host))
        throw new UpstreamBlocked(`${host} is not a public address`);
    }
    const response = await fetch(up.url, {
      method: up.method,
      headers: up.headers,
      ...(up.bytes !== undefined
        ? { body: up.bytes }
        : up.body !== undefined
          ? { body: up.body }
          : {}),
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
