/**
 * Opens the upstream Realtime WebSocket (card 30.5) with the same outbound rules as HTTP calls:
 * the SSRF guard for customer providers (card 22.3), the credential/provider/global outbound proxy
 * (HTTP CONNECT or SOCKS5, card 4.10) and the connect timeout. A failed handshake is classified
 * like an HTTP error (status and body), so a 401 disables the credential and a 429 or 5xx falls
 * back to the next target, exactly as for chat.
 */
import type { ClientRequestArgs } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';

import type { ProviderConfig } from '@dirouter/contracts';
import {
  adapterForProvider,
  type ClassifiedError,
  classifyNetworkError,
  type RealtimeTarget,
} from '@dirouter/providers';
import { isBlockedAddress } from '@dirouter/shared';
import { SocksClient } from 'socks';
import { type RawData, WebSocket } from 'ws';

import { guardedOrganization, maskProxyUrl, publicOnlyLookup } from './upstream.js';

/** Largest event accepted from either side (audio arrives base64-encoded). */
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024 * 1024;

export type UpstreamOpen =
  { ok: true; ws: WebSocket; early: RawData[] } | { ok: false; error: ClassifiedError };

type Callback = (error: Error | null, socket: Duplex) => void;

/** `createConnection` for `ws` through an HTTP(S) CONNECT or SOCKS5 proxy. */
export function proxyConnection(
  proxyUrl: string,
  target: URL,
  timeoutMs: number,
): (options: ClientRequestArgs, callback: Callback) => undefined {
  const proxy = new URL(proxyUrl);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port) || (target.protocol === 'wss:' ? 443 : 80);
  const secure = target.protocol === 'wss:';
  const fail = (callback: Callback, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    callback(
      Object.assign(
        new Error(
          `proxy ${maskProxyUrl(proxyUrl)}: ${message.replaceAll(proxyUrl, maskProxyUrl(proxyUrl))}`,
        ),
        { code: 'ECONNREFUSED' },
      ),
      undefined as unknown as Duplex,
    );
  };
  const finish = (socket: Socket, callback: Callback) => {
    if (!secure) {
      callback(null, socket);
      return;
    }
    const tls = tlsConnect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
    tls.once('secureConnect', () => {
      callback(null, tls);
    });
    tls.once('error', (error) => {
      fail(callback, error);
    });
  };
  return (_options, callback) => {
    if (/^socks5h?:$/.test(proxy.protocol)) {
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
      })
        .then(({ socket }) => {
          finish(socket, callback);
        })
        .catch((error: unknown) => {
          fail(callback, error);
        });
      return undefined;
    }
    const auth =
      proxy.username || proxy.password
        ? {
            'proxy-authorization': `Basic ${Buffer.from(
              `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
            ).toString('base64')}`,
          }
        : {};
    const connect = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      host: proxy.hostname,
      port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host.includes(':') ? `[${host}]` : host}:${String(port)}`,
      headers: { host: `${host}:${String(port)}`, ...auth },
      timeout: timeoutMs,
    });
    connect.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(callback, new Error(`CONNECT answered ${String(res.statusCode)}`));
        return;
      }
      finish(socket, callback);
    });
    connect.once('timeout', () => {
      connect.destroy(new Error('proxy connect timeout'));
    });
    connect.once('error', (error) => {
      fail(callback, error);
    });
    connect.end();
    return undefined;
  };
}

/** Opens the socket; messages that arrive before the session takes over are kept in `early`. */
export function openUpstream(
  provider: ProviderConfig,
  target: RealtimeTarget,
  options: { connectMs: number; handshakeMs: number; proxyUrl?: string; signal: AbortSignal },
): Promise<UpstreamOpen> {
  const url = new URL(target.url);
  const guarded = guardedOrganization(provider.organizationId);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (guarded && isIP(host) !== 0 && isBlockedAddress(host))
    return Promise.resolve({
      ok: false,
      error: classifyNetworkError(
        Object.assign(new Error(`${host} is not a public address`), { code: 'EBLOCKED' }),
        false,
      ),
    });
  if (options.signal.aborted)
    return Promise.resolve({
      ok: false,
      error: classifyNetworkError(new Error('aborted'), false),
    });

  const settings: Record<string, unknown> = {
    headers: target.headers,
    handshakeTimeout: options.handshakeMs,
    perMessageDeflate: false,
    maxPayload: MAX_REALTIME_MESSAGE_BYTES,
    followRedirects: false,
    ...(options.proxyUrl
      ? { createConnection: proxyConnection(options.proxyUrl, url, options.connectMs) }
      : guarded
        ? { lookup: publicOnlyLookup }
        : {}),
  };
  const ws = new WebSocket(target.url, settings);
  const early: RawData[] = [];
  const keep = (data: RawData) => early.push(data);
  ws.on('message', keep);

  return new Promise<UpstreamOpen>((resolve) => {
    let settled = false;
    const done = (result: UpstreamOpen) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      if (!result.ok) {
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        ws.terminate();
      }
      resolve(result);
    };
    const onAbort = () => {
      done({ ok: false, error: classifyNetworkError(new Error('aborted'), false) });
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    ws.once('open', () => {
      done({ ok: true, ws, early });
    });
    ws.once('unexpected-response', (_req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size < 16_384) chunks.push(chunk);
        size += chunk.length;
      });
      const classify = () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers))
          if (typeof value === 'string') headers.set(name, value);
        done({
          ok: false,
          error: adapterForProvider(provider).classifyError({
            status: res.statusCode ?? 502,
            headers,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 16_384),
          }),
        });
      };
      res.once('end', classify);
      res.once('error', classify);
    });
    ws.once('error', (error) => {
      done({
        ok: false,
        error: classifyNetworkError(error, /handshake has timed out/i.test(error.message)),
      });
    });
  });
}
