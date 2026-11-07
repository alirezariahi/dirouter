/**
 * timeoutهای چندلایه (کارت ۵.۴) و بستن upstream با قطع کلاینت (کارت ۴.۵)، روی
 * سرورهای خام TCP/HTTP تا رفتار شبکه دقیق کنترل شود.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';

import type { ProviderConfig } from '@dirouter/contracts';
import { classifyNetworkError } from '@dirouter/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callUpstream, mergeTimeouts, UpstreamTimeout } from './upstream.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = (_req, res) => res.end('ok');
let http: Server;
let httpUrl = '';
let closedAt = 0;
let blackhole: TcpServer;
let blackholeUrl = '';
const sockets = new Set<Socket>();

beforeAll(async () => {
  http = createHttpServer((req, res) => {
    req.socket.once('close', () => {
      closedAt = Date.now();
    });
    handler(req, res);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const a = http.address();
  httpUrl = `http://127.0.0.1:${String(typeof a === 'object' && a ? a.port : 0)}`;
  // اتصال TCP را می‌پذیرد ولی هیچ‌وقت handshake TLS را کامل نمی‌کند.
  blackhole = createTcpServer((s) => {
    sockets.add(s);
  });
  await new Promise<void>((r) => blackhole.listen(0, '127.0.0.1', r));
  const b = blackhole.address();
  blackholeUrl = `https://127.0.0.1:${String(typeof b === 'object' && b ? b.port : 0)}`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
  await new Promise((r) => blackhole.close(r));
});

const provider = (baseUrl: string, id: string): ProviderConfig =>
  ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai-compatible',
    name: id,
    baseUrl,
    enabled: true,
    options: {},
    credentials: [],
  }) as unknown as ProviderConfig;

const req = (url: string) => ({ url, method: 'POST' as const, headers: {}, body: '{}' });
const timeouts = (t: Parameters<typeof mergeTimeouts>[0]) =>
  mergeTimeouts({ connectMs: 5_000, firstByteMs: 5_000, idleMs: 5_000, totalMs: 10_000 }, t);

async function readAll(call: Awaited<ReturnType<typeof callUpstream>>): Promise<string> {
  let text = '';
  for await (const chunk of call.response.body ?? []) {
    call.touch();
    text += Buffer.from(chunk as Uint8Array).toString();
  }
  return text;
}

describe('layered upstream timeouts', () => {
  it('connect: a handshake that never completes fails fast and is retryable', async () => {
    const started = Date.now();
    const error = await callUpstream(
      provider(blackholeUrl, 'connect'),
      req(`${blackholeUrl}/v1/chat/completions`),
      timeouts({ connectMs: 200 }),
      new AbortController().signal,
      false,
    ).catch((e: unknown) => e);
    // connectMs=200؛ سقف گشاده برای runnerهای شلوغ CI، ولی بسیار کمتر از پیش‌فرض ۵ ثانیه.
    expect(Date.now() - started).toBeLessThan(3_000);
    const classified = classifyNetworkError(error, error instanceof UpstreamTimeout);
    expect(classified.class).toBe('timeout');
    expect(classified.fallbackAllowed).toBe(true);
  });

  it('first byte: headers that never come abort at the TTFT limit', async () => {
    handler = () => undefined; // هیچ پاسخی
    const started = Date.now();
    const error = await callUpstream(
      provider(httpUrl, 'ttft'),
      req(`${httpUrl}/x`),
      timeouts({ firstByteMs: 200 }),
      new AbortController().signal,
      true,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamTimeout);
    expect((error as UpstreamTimeout).kind).toBe('first_byte');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('first byte also covers headers without a first chunk on a stream', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
    };
    const call = await callUpstream(
      provider(httpUrl, 'ttft2'),
      req(`${httpUrl}/x`),
      timeouts({ firstByteMs: 200 }),
      new AbortController().signal,
      true,
    );
    const error = await readAll(call).catch((e: unknown) => e);
    expect(call.signal.reason).toBeInstanceOf(UpstreamTimeout);
    expect((call.signal.reason as UpstreamTimeout).kind).toBe('first_byte');
    expect(error).toBeInstanceOf(Error);
    call.done();
  });

  it('idle: a stream that stalls after the first chunk aborts', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
    };
    const started = Date.now();
    const call = await callUpstream(
      provider(httpUrl, 'idle'),
      req(`${httpUrl}/x`),
      timeouts({ idleMs: 250 }),
      new AbortController().signal,
      true,
    );
    await readAll(call).catch(() => undefined);
    expect((call.signal.reason as UpstreamTimeout).kind).toBe('idle');
    expect(Date.now() - started).toBeLessThan(1_500);
    call.done();
  });

  it('total: a stream that keeps trickling still ends at the total limit', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => res.write('data: x\n\n'), 50);
      res.on('close', () => {
        clearInterval(t);
      });
    };
    const started = Date.now();
    const call = await callUpstream(
      provider(httpUrl, 'total'),
      req(`${httpUrl}/x`),
      timeouts({ idleMs: 1_000, totalMs: 400 }),
      new AbortController().signal,
      true,
    );
    await readAll(call).catch(() => undefined);
    expect((call.signal.reason as UpstreamTimeout).kind).toBe('total');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(1_500);
    call.done();
  });

  it('non-stream requests are not cut by the TTFT limit (the model builds the whole answer)', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{"ok":true}'), 300);
    };
    const call = await callUpstream(
      provider(httpUrl, 'slow-json'),
      req(`${httpUrl}/x`),
      timeouts({ firstByteMs: 100 }),
      new AbortController().signal,
      false,
    );
    expect(await call.response.text()).toBe('{"ok":true}');
    call.done();
  });

  it('provider and combo layers override the defaults field by field', () => {
    expect(mergeTimeouts({ connectMs: 1, totalMs: 9 }, { totalMs: 5 }, undefined)).toMatchObject({
      connectMs: 1,
      totalMs: 5,
    });
  });
});

describe('client disconnect', () => {
  it('closes the upstream connection within a second', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const t = setInterval(() => res.write('data: x\n\n'), 100);
      res.on('close', () => {
        clearInterval(t);
      });
    };
    closedAt = 0;
    const client = new AbortController();
    const call = await callUpstream(
      provider(httpUrl, 'disconnect'),
      req(`${httpUrl}/x`),
      timeouts({}),
      client.signal,
      true,
    );
    const reading = readAll(call).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 250));
    const abortedAt = Date.now();
    client.abort(new Error('client disconnected'));
    await reading;
    for (let i = 0; i < 50 && closedAt === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(closedAt).toBeGreaterThan(0);
    expect(closedAt - abortedAt).toBeLessThan(1_000);
    call.done();
  });
});
