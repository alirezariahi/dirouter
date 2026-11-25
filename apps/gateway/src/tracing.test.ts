/**
 * OpenTelemetry tracing (card 17.2): W3C propagation, parent-based sampling, span hierarchy and the
 * OTLP export, plus an end-to-end check through a real gateway with a local collector.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, TracingSettings } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';
import { formatTraceparent, parseTraceparent, Tracer } from './tracing.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const on = (over: Partial<TracingSettings> = {}): TracingSettings => ({
  enabled: true,
  endpoint: 'http://collector.invalid/v1/traces',
  serviceName: 'dirouter-gateway',
  sampleRatio: 1,
  attributes: 'both',
  ...over,
});

interface ExportedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  status: { code: number };
  attributes: { key: string; value: Record<string, unknown> }[];
}
function capture() {
  const bodies: {
    resourceSpans: { resource: unknown; scopeSpans: { spans: ExportedSpan[] }[] }[];
  }[] = [];
  const fetchImpl = ((_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as (typeof bodies)[number]);
    return Promise.resolve(new Response('{}'));
  }) as unknown as typeof fetch;
  const spans = () =>
    bodies.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  return { fetchImpl, spans, bodies };
}

describe('traceparent', () => {
  it('parses a valid header and its sampled flag', () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01`)).toEqual({
      traceId: TRACE,
      spanId: PARENT,
      sampled: true,
    });
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-00`)?.sampled).toBe(false);
    expect(parseTraceparent(`00-${TRACE.toUpperCase()}-${PARENT}-01`)?.traceId).toBe(TRACE);
  });

  it('ignores malformed and all-zero values', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${PARENT}-01`)).toBeUndefined();
    expect(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`)).toBeUndefined();
    expect(parseTraceparent(['a', 'b'])).toBeUndefined();
  });

  it('round-trips through formatTraceparent', () => {
    expect(parseTraceparent(formatTraceparent(TRACE, PARENT, true))).toEqual({
      traceId: TRACE,
      spanId: PARENT,
      sampled: true,
    });
  });
});

describe('Tracer', () => {
  it('records nothing while disabled or without an endpoint', async () => {
    for (const settings of [undefined, on({ enabled: false }), { ...on(), endpoint: undefined }]) {
      const out = capture();
      const tracer = new Tracer(settings, logger, out.fetchImpl);
      const span = tracer.startRequest('gateway.request');
      expect(span.sampled).toBe(false);
      span.child('gateway.upstream').end();
      span.end();
      await tracer.shutdown();
      expect(out.spans()).toEqual([]);
    }
  });

  it('creates well-formed ids and a child/parent hierarchy', async () => {
    const out = capture();
    const tracer = new Tracer(on(), logger, out.fetchImpl);
    const root = tracer.startRequest('gateway.request', { 'gateway.model': 'm' });
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.traceparent).toBe(`00-${root.traceId}-${root.spanId}-01`);
    const child = root.child('gateway.upstream', { 'gateway.provider': 'p' });
    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).not.toBe(root.spanId);
    child.end('error', { 'gateway.error_class': 'server' });
    root.end('ok', { 'gateway.attempts': 1 });
    root.end('ok'); // ending twice does not export twice
    await tracer.shutdown();
    const spans = out.spans();
    expect(spans.map((s) => s.name)).toEqual(['gateway.upstream', 'gateway.request']);
    expect(spans[0]?.parentSpanId).toBe(root.spanId);
    expect(spans[0]?.kind).toBe(3);
    expect(spans[0]?.status.code).toBe(2);
    expect(spans[1]?.parentSpanId).toBeUndefined();
    expect(spans[1]?.kind).toBe(2);
    expect(spans[1]?.attributes).toContainEqual({
      key: 'gateway.model',
      value: { stringValue: 'm' },
    });
    expect(spans[1]?.attributes).toContainEqual({
      key: 'gateway.attempts',
      value: { intValue: '1' },
    });
    expect(JSON.stringify(out.bodies[0]?.resourceSpans[0]?.resource)).toContain('dirouter-gateway');
  });

  it('continues an incoming trace and follows the parent sampling decision', async () => {
    const out = capture();
    // sampleRatio 0: only the caller's decision can turn recording on.
    const tracer = new Tracer(on({ sampleRatio: 0 }), logger, out.fetchImpl);
    const sampled = tracer.startRequest('gateway.request', {}, `00-${TRACE}-${PARENT}-01`);
    expect(sampled.traceId).toBe(TRACE);
    expect(sampled.sampled).toBe(true);
    sampled.end();
    const unsampled = tracer.startRequest('gateway.request', {}, `00-${TRACE}-${PARENT}-00`);
    expect(unsampled.sampled).toBe(false);
    expect(unsampled.traceparent.endsWith('-00')).toBe(true);
    expect(unsampled.child('gateway.upstream').traceparent.startsWith(`00-${TRACE}-`)).toBe(true);
    unsampled.end();
    const fresh = tracer.startRequest('gateway.request');
    expect(fresh.sampled).toBe(false);
    fresh.end();
    await tracer.shutdown();
    const spans = out.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.parentSpanId).toBe(PARENT);
  });

  it('samples requests without a parent by ratio', async () => {
    const out = capture();
    const values = [0.05, 0.5, 0.09, 0.99];
    let i = 0;
    const tracer = new Tracer(
      on({ sampleRatio: 0.1 }),
      logger,
      out.fetchImpl,
      () => values[i++ % values.length] ?? 1,
    );
    const decisions = values.map(() => {
      const span = tracer.startRequest('gateway.request');
      span.end();
      return span.sampled;
    });
    expect(decisions).toEqual([true, false, true, false]);
    await tracer.shutdown();
    expect(out.spans()).toHaveLength(2);
  });

  it('settings are read live, so tracing can be switched without a restart', async () => {
    const out = capture();
    let settings: TracingSettings | undefined;
    const tracer = new Tracer(() => settings, logger, out.fetchImpl);
    expect(tracer.startRequest('a').sampled).toBe(false);
    settings = on();
    expect(tracer.startRequest('b').sampled).toBe(true);
    settings = on({ enabled: false });
    expect(tracer.startRequest('c').sampled).toBe(false);
    await tracer.shutdown();
  });

  it('a failing collector never throws into the request path', async () => {
    const failing = (() => Promise.reject(new Error('collector down'))) as unknown as typeof fetch;
    const tracer = new Tracer(on(), logger, failing);
    tracer.startRequest('gateway.request').end();
    await tracer.flush();
    expect(tracer.pending).toBe(0);
    expect(tracer.dropped).toBe(1);
    await tracer.shutdown();
  });
});

describe('tracing through the gateway', () => {
  const keyring = parseKeyring(generateKey());
  const pepper = 'p'.repeat(32);
  const KEY = 'dr-trace-test-key-0001';
  const mock = buildMock();
  const received: ExportedSpan[] = [];
  let collector: Server;
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    collector = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as {
          resourceSpans: { scopeSpans: { spans: ExportedSpan[] }[] }[];
        };
        received.push(...parsed.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const ca = collector.address();
    const collectorUrl = `http://127.0.0.1:${String(typeof ca === 'object' && ca ? ca.port : 0)}/v1/traces`;
    await mock.listen({ port: 0, host: '127.0.0.1' });
    const ma = mock.server.address();
    const mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
    const snapshot: ConfigSnapshotInput = {
      schemaVersion: 1,
      version: 1,
      generatedAt: new Date().toISOString(),
      providers: [
        {
          id: 'oa',
          organizationId: 'org',
          slug: 'oa',
          type: 'openai-compatible',
          name: 'oa',
          baseUrl: `${mockRoot}/v1`,
          enabled: true,
          options: {},
          credentials: [
            { id: 'oa-k', name: 'oa', secret: encrypt(keyring, 'sk-x', 'oa-k'), enabled: true },
          ],
        },
      ],
      models: [
        {
          id: 'gpt-x',
          organizationId: 'org',
          slug: 'gpt-x',
          providerId: 'oa',
          upstreamModel: 'mock-small',
          enabled: true,
          contextWindow: 100_000,
          pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
          capabilities: {},
        },
      ],
      combos: [],
      aliases: [],
      virtualKeys: [
        {
          id: 'vk',
          hash: hashApiKey(KEY, pepper),
          prefix: 'dr-trac',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
        },
      ],
      // Ratio 0: only requests that arrive with a sampled traceparent are recorded.
      settings: { tracing: { enabled: true, endpoint: collectorUrl, sampleRatio: 0 } },
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-trace-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    gw = buildGateway({ logger, keyring, pepper, dataDir, emitUsage: () => undefined });
    await gw.start();
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });

  afterAll(async () => {
    await gw.app.close();
    await mock.close();
    await new Promise((resolve) => collector.close(resolve));
  });

  const chat = (headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers },
      body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: 'trace me' }] }),
    });
  const waitForSpans = async (count: number) => {
    const deadline = Date.now() + 5_000;
    while (received.length < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
  };

  it('exports a request span under the caller and one upstream span under it', async () => {
    expect((await chat({ traceparent: `00-${TRACE}-${PARENT}-01` })).status).toBe(200);
    await waitForSpans(2);
    const request = received.find((s) => s.name === 'gateway.request');
    // The upstream attempt is a GenAI inference CLIENT span named `{operation} {model}` (24.3).
    const upstream = received.find((s) => s.kind === 3);
    expect(upstream?.name).toBe('chat mock-small');
    expect(request?.traceId).toBe(TRACE);
    expect(request?.parentSpanId).toBe(PARENT);
    expect(upstream?.traceId).toBe(TRACE);
    expect(upstream?.parentSpanId).toBe(request?.spanId);
    expect(upstream?.attributes).toContainEqual({
      key: 'gateway.provider',
      value: { stringValue: 'oa' },
    });
  });

  it('does not record requests that are not sampled', async () => {
    const before = received.length;
    expect((await chat()).status).toBe(200);
    expect((await chat({ traceparent: `00-${TRACE}-${PARENT}-00` })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(received.length).toBe(before);
  });
});
