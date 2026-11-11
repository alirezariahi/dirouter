/**
 * Outbound proxy (card 4.10): SOCKS5 with/without auth, socks5h (DNS on the proxy side),
 * HTTP proxy, a broken proxy treated as a network error with fallback, credential precedence over provider,
 * and masking of the proxy password.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import {
  connect as netConnect,
  createServer as createTcpServer,
  type Server as TcpServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, ProviderConfig } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { classifyNetworkError } from '@dirouter/providers';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';
import { callUpstream, maskProxyUrl, mergeTimeouts, UpstreamTimeout } from './upstream.js';

const listen = async (s: Server | TcpServer) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const a = s.address();
  return typeof a === 'object' && a ? a.port : 0;
};

/** Minimal SOCKS5 server (RFC 1928/1929): no-auth or user/pass, CONNECT only. */
function socksServer(auth?: { user: string; pass: string }) {
  const seen: string[] = [];
  const server = createTcpServer((client) => {
    client.once('data', (greeting) => {
      const methods = [...greeting.subarray(2, 2 + (greeting[1] ?? 0))];
      const method = auth ? 0x02 : 0x00;
      if (!methods.includes(method)) return client.end(Buffer.from([5, 0xff]));
      client.write(Buffer.from([5, method]));
      const onRequest = (req: Buffer) => {
        let host = '';
        let i = 4;
        if (req[3] === 1) {
          host = [...req.subarray(4, 8)].join('.');
          i = 8;
        } else if (req[3] === 4) {
          const parts: string[] = [];
          for (let j = 0; j < 16; j += 2) parts.push(req.readUInt16BE(4 + j).toString(16));
          host = parts.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
          i = 20;
        } else if (req[3] === 3) {
          const len = req[4] ?? 0;
          host = req.subarray(5, 5 + len).toString();
          i = 5 + len;
        }
        const port = req.readUInt16BE(i);
        seen.push(`${host}:${String(port)}`);
        // The test destination only listens on IPv4.
        const dial = host === 'localhost' || host.includes(':') ? '127.0.0.1' : host;
        const upstream = netConnect(port, dial, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream).pipe(client);
        });
        upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      };
      if (!auth) return client.once('data', onRequest);
      client.once('data', (creds) => {
        const ulen = creds[1] ?? 0;
        const user = creds.subarray(2, 2 + ulen).toString();
        const pass = creds.subarray(3 + ulen, 3 + ulen + (creds[2 + ulen] ?? 0)).toString();
        const ok = user === auth.user && pass === auth.pass;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return client.end();
        client.once('data', onRequest);
      });
    });
    client.on('error', () => undefined);
  });
  return { server, seen };
}

/** Minimal HTTP proxy for http destinations (absolute-form requests). */
function httpProxy() {
  const seen: string[] = [];
  const server = createHttpServer((req, res) => {
    seen.push(req.url ?? '');
    const target = new URL(req.url ?? '');
    const up = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(up);
  });
  return { server, seen };
}

const target = createHttpServer((_req, res) => res.end('{"ok":true}'));
const plain = socksServer();
const authed = socksServer({ user: 'u', pass: 's3cr3t' });
const hp = httpProxy();
const closedPort = createTcpServer();
let targetPort = 0;
let plainUrl = '';
let authedUrl = '';
let httpProxyUrl = '';
let deadProxyUrl = '';

beforeAll(async () => {
  targetPort = await listen(target);
  plainUrl = `socks5h://127.0.0.1:${String(await listen(plain.server))}`;
  authedUrl = `socks5://u:s3cr3t@127.0.0.1:${String(await listen(authed.server))}`;
  httpProxyUrl = `http://127.0.0.1:${String(await listen(hp.server))}`;
  // A port that is definitely closed.
  const p = await listen(closedPort);
  await new Promise((r) => closedPort.close(r));
  deadProxyUrl = `socks5://user:topsecret@127.0.0.1:${String(p)}`;
});

afterAll(async () => {
  for (const s of [target, plain.server, authed.server, hp.server]) {
    if ('closeAllConnections' in s) s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const provider = (id: string): ProviderConfig =>
  ({
    id,
    organizationId: 'o',
    slug: id,
    type: 'openai-compatible',
    name: id,
    baseUrl: '',
    enabled: true,
    options: {},
    credentials: [],
  }) as unknown as ProviderConfig;
const timeouts = mergeTimeouts({
  connectMs: 2_000,
  firstByteMs: 5_000,
  idleMs: 5_000,
  totalMs: 10_000,
});
const get = (id: string, url: string, proxy: string) =>
  callUpstream(
    provider(id),
    { url, method: 'GET', headers: {} },
    timeouts,
    new AbortController().signal,
    false,
    proxy,
  );

describe('outbound proxies', () => {
  it('socks5h passes the host name to the proxy (remote DNS)', async () => {
    const call = await get('s1', `http://localhost:${String(targetPort)}/x`, plainUrl);
    expect(await call.response.text()).toBe('{"ok":true}');
    expect(plain.seen.at(-1)).toBe(`localhost:${String(targetPort)}`);
    call.done();
  });

  it('socks5 with username and password resolves locally', async () => {
    const call = await get('s2', `http://localhost:${String(targetPort)}/x`, authedUrl);
    expect(call.response.status).toBe(200);
    await call.response.text();
    expect(authed.seen.at(-1)).toMatch(/^(127\.0\.0\.1|::1):/);
    call.done();
  });

  it('wrong socks credentials fail as a connection error', async () => {
    const wrong = authedUrl.replace('s3cr3t', 'nope');
    const error = await get('s3', `http://localhost:${String(targetPort)}/x`, wrong).catch(
      (e: unknown) => e,
    );
    const c = classifyNetworkError(error, error instanceof UpstreamTimeout);
    expect(c.class).toBe('connection');
    expect(c.fallbackAllowed).toBe(true);
  });

  it('http proxy forwards the request', async () => {
    const call = await get('h1', `http://127.0.0.1:${String(targetPort)}/y?z=1`, httpProxyUrl);
    expect(await call.response.text()).toBe('{"ok":true}');
    expect(hp.seen.at(-1)).toBe(`http://127.0.0.1:${String(targetPort)}/y?z=1`);
    call.done();
  });

  it('a dead proxy is a retryable network error and never leaks its password', async () => {
    const error = await get('d1', `http://127.0.0.1:${String(targetPort)}/`, deadProxyUrl).catch(
      (e: unknown) => e,
    );
    const c = classifyNetworkError(error, error instanceof UpstreamTimeout);
    expect(c.class).toBe('connection');
    expect(c.retryable && c.fallbackAllowed).toBe(true);
    expect(JSON.stringify(c)).not.toContain('topsecret');
    expect(maskProxyUrl(deadProxyUrl)).toBe(deadProxyUrl.replace('topsecret', '***'));
  });
});

describe('proxy selection in the gateway', () => {
  const keyring = parseKeyring(generateKey());
  const pepper = 'p'.repeat(32);
  const KEY = 'dr-test-proxy-key';
  const mock = buildMock();
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockPort = typeof ma === 'object' && ma ? ma.port : 0;
    const cred = (id: string, proxy?: string) => ({
      id,
      name: id,
      secret: encrypt(keyring, 'sk-x', id),
      enabled: true,
      ...(proxy ? { proxy: { url: proxy } } : {}),
    });
    const prov = (id: string, creds: ReturnType<typeof cred>[], proxy?: string) => ({
      id,
      organizationId: 'org',
      slug: id,
      type: 'openai-compatible' as const,
      name: id,
      baseUrl: `http://localhost:${String(mockPort)}/v1`,
      enabled: true,
      options: {},
      credentials: creds,
      ...(proxy ? { proxy: { url: proxy } } : {}),
    });
    const model = (id: string, providerId: string) => ({
      id,
      organizationId: 'org',
      slug: id,
      providerId,
      upstreamModel: 'mock-small',
      enabled: true,
      contextWindow: 100_000,
      pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
      capabilities: {},
    });
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        // Broken proxy on the provider, but the proxy credential has its own healthy one.
        prov('override', [cred('override-k', plainUrl)], deadProxyUrl),
        prov('broken', [cred('broken-k')], deadProxyUrl),
        prov('direct', [cred('direct-k')]),
      ],
      models: [
        model('override-m', 'override'),
        model('broken-m', 'broken'),
        model('direct-m', 'direct'),
      ],
      combos: [
        {
          id: 'cmb',
          organizationId: 'org',
          slug: 'via-broken-proxy',
          strategy: 'priority',
          targets: [
            { modelId: 'broken-m', order: 0 },
            { modelId: 'direct-m', order: 1 },
          ],
          retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
        },
      ],
      aliases: [],
      virtualKeys: [
        {
          id: 'vk',
          hash: hashApiKey(KEY, pepper),
          prefix: 'dr-test',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
        },
      ],
      settings: {},
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-proxy-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({
      logger: createLogger({ service: 'test', level: 'silent' }),
      keyring,
      pepper,
      dataDir,
      emitUsage: () => undefined,
    });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });

  afterAll(async () => {
    await gw.app.close();
    await mock.close();
  });

  const chat = (model: string) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });

  it('a credential proxy wins over the provider proxy', async () => {
    const before = plain.seen.length;
    const res = await chat('override-m');
    expect(res.status).toBe(200);
    expect(plain.seen.length).toBe(before + 1);
  });

  it('a broken proxy falls back to the next provider', async () => {
    const res = await chat('via-broken-proxy');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dirouter-provider')).toBe('direct');
    expect(res.headers.get('x-dirouter-attempts')).toBe('2');
  });
});
