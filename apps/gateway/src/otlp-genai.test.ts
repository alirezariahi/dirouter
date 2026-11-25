/**
 * OpenTelemetry GenAI semantic conventions and OTLP metrics and logs (card 24.3): the attribute
 * modes, the conversion of the Prometheus registry and of log lines, and one request through a real
 * gateway whose traces, metrics and logs reach a local collector.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput, TracingSettings } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { Counter, Histogram, Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  genAiOperation,
  genAiProviderName,
  genAiResponseAttributes,
  shapeAttributes,
  withErrorType,
} from './genai.js';
import { OtlpLogBuffer, toOtlpLog, toOtlpMetrics } from './otlp-export.js';
import { buildGateway } from './server.js';
import { Tracer } from './tracing.js';

interface OtlpAttr {
  key: string;
  value: Record<string, unknown>;
}
interface Span {
  name: string;
  kind: number;
  traceId: string;
  attributes: OtlpAttr[];
}
const attr = (attrs: OtlpAttr[] | undefined, key: string) =>
  attrs?.find((a) => a.key === key)?.value;
const keys = (attrs: OtlpAttr[] | undefined) => (attrs ?? []).map((a) => a.key);
const silent = createLogger({ service: 'test', level: 'silent' });

describe('GenAI semantic conventions', () => {
  it('maps provider types to gen_ai.provider.name and APIs to gen_ai.operation.name', () => {
    expect(genAiProviderName('openai')).toBe('openai');
    expect(genAiProviderName('azure-openai')).toBe('azure.ai.openai');
    expect(genAiProviderName('anthropic')).toBe('anthropic');
    expect(genAiProviderName('gemini')).toBe('gcp.gemini');
    expect(genAiProviderName('vertex')).toBe('gcp.vertex_ai');
    expect(genAiProviderName('bedrock')).toBe('aws.bedrock');
    expect(genAiProviderName('mistral')).toBe('mistral_ai');
    expect(genAiProviderName('openai-compatible')).toBe('openai-compatible');
    expect(genAiOperation('openai.chat')).toBe('chat');
    expect(genAiOperation('anthropic.messages')).toBe('chat');
    expect(genAiOperation('gemini.generate')).toBe('generate_content');
  });

  it('describes an answer with id, model, finish reasons and usage', () => {
    expect(
      genAiResponseAttributes(
        { id: 'r1', model: 'gpt-4o-2024', content: [], finishReason: 'length', created: 0 },
        {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          reasoningTokens: 2,
        },
      ),
    ).toEqual({
      'gen_ai.response.id': 'r1',
      'gen_ai.response.model': 'gpt-4o-2024',
      'gen_ai.response.finish_reasons': ['length'],
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 4,
      'gen_ai.usage.cache_read.input_tokens': 3,
      'gen_ai.usage.reasoning.output_tokens': 2,
    });
  });

  it('keeps both names by default, and one family in gen_ai or legacy mode', () => {
    const all = withErrorType({
      'gateway.provider': 'oa',
      'gateway.error_class': 'timeout',
      'gen_ai.provider.name': 'openai',
    });
    expect(all['error.type']).toBe('timeout');
    expect(shapeAttributes('both', all)).toEqual(all);
    expect(Object.keys(shapeAttributes('gen_ai', all)).sort()).toEqual([
      'error.type',
      'gen_ai.provider.name',
    ]);
    expect(Object.keys(shapeAttributes('legacy', all)).sort()).toEqual([
      'gateway.error_class',
      'gateway.provider',
    ]);
  });

  it('the tracer names spans and filters attributes by mode', async () => {
    const run = async (mode: TracingSettings['attributes']) => {
      const bodies: string[] = [];
      const tracer = new Tracer(
        {
          enabled: true,
          endpoint: 'http://collector.invalid/v1/traces',
          serviceName: 's',
          sampleRatio: 1,
          attributes: mode,
        },
        silent,
        ((_u: string, init: { body: string }) => {
          bodies.push(init.body);
          return Promise.resolve(new Response('{}'));
        }) as unknown as typeof fetch,
      );
      const root = tracer.startRequest('gateway.request', { 'gateway.model': 'm' });
      root
        .child(
          'gateway.upstream',
          { 'gateway.provider': 'oa', 'gen_ai.provider.name': 'openai' },
          'chat up',
        )
        .end('error', { 'gateway.error_class': 'timeout' });
      root.end();
      await tracer.flush();
      const parsed = JSON.parse(bodies[0] ?? '{}') as {
        resourceSpans: { scopeSpans: { schemaUrl?: string; spans: Span[] }[] }[];
      };
      const scope = parsed.resourceSpans[0]?.scopeSpans[0];
      return { scope, child: scope?.spans.find((s) => s.kind === 3) };
    };
    const legacy = await run('legacy');
    expect(legacy.child?.name).toBe('gateway.upstream');
    expect(keys(legacy.child?.attributes).sort()).toEqual([
      'gateway.error_class',
      'gateway.provider',
    ]);
    expect(legacy.scope?.schemaUrl).toBeUndefined();
    const genAi = await run('gen_ai');
    expect(genAi.child?.name).toBe('chat up');
    expect(keys(genAi.child?.attributes).sort()).toEqual(['error.type', 'gen_ai.provider.name']);
    expect(genAi.scope?.schemaUrl).toBe('https://opentelemetry.io/schemas/1.41.0');
    const both = await run('both');
    expect(keys(both.child?.attributes)).toHaveLength(4);
  });
});

describe('OTLP conversion', () => {
  it('converts counters and histograms, with GenAI metrics under their convention names', async () => {
    const registry = new Registry();
    new Counter({
      name: 'dirouter_gateway_requests_total',
      help: 'h',
      labelNames: ['provider'],
      registers: [registry],
    }).inc({ provider: 'oa' }, 3);
    const tokens = new Histogram({
      name: 'dirouter_gateway_gen_ai_client_token_usage',
      help: 'h',
      labelNames: ['operation', 'provider', 'request_model', 'response_model', 'token_type'],
      buckets: [10, 100],
      registers: [registry],
    });
    const base = { operation: 'chat', provider: 'openai', request_model: 'm', response_model: '' };
    tokens.observe({ ...base, token_type: 'input' }, 5);
    tokens.observe({ ...base, token_type: 'input' }, 50);
    tokens.observe({ ...base, token_type: 'input' }, 500);
    const metrics = toOtlpMetrics(await registry.getMetricsAsJSON(), 1_000, 2_000) as {
      name: string;
      unit?: string;
      sum?: { dataPoints: { asDouble: number; attributes: OtlpAttr[] }[]; isMonotonic: boolean };
      histogram?: {
        dataPoints: {
          count: string;
          sum: number;
          bucketCounts: string[];
          explicitBounds: number[];
          attributes: OtlpAttr[];
        }[];
      };
    }[];
    const counter = metrics.find((m) => m.name === 'dirouter_gateway_requests_total');
    expect(counter?.sum?.isMonotonic).toBe(true);
    expect(counter?.sum?.dataPoints[0]?.asDouble).toBe(3);
    const usage = metrics.find((m) => m.name === 'gen_ai.client.token.usage');
    expect(usage?.unit).toBe('{token}');
    const point = usage?.histogram?.dataPoints[0];
    expect(point).toMatchObject({
      count: '3',
      sum: 555,
      explicitBounds: [10, 100],
      bucketCounts: ['1', '1', '1'],
    });
    expect(attr(point?.attributes, 'gen_ai.token.type')).toEqual({ stringValue: 'input' });
    expect(attr(point?.attributes, 'gen_ai.provider.name')).toEqual({ stringValue: 'openai' });
    // An empty optional label is absent, not an empty string.
    expect(attr(point?.attributes, 'gen_ai.response.model')).toBeUndefined();
  });

  it('turns a log line into a log record and buffers only at the chosen level', () => {
    const line = JSON.stringify({
      level: 'warn',
      time: '2026-11-25T10:00:00.000Z',
      msg: 'request completed',
      service: 'gateway',
      requestId: 'req_1',
      latencyMs: 12,
      nested: { a: 1 },
    });
    const log = toOtlpLog(line)?.record as {
      severityNumber: number;
      severityText: string;
      body: { stringValue: string };
      attributes: OtlpAttr[];
      timeUnixNano: string;
    };
    expect(log.severityNumber).toBe(13);
    expect(log.severityText).toBe('WARN');
    expect(log.body.stringValue).toBe('request completed');
    expect(log.timeUnixNano).toBe(`${String(Date.parse('2026-11-25T10:00:00.000Z'))}000000`);
    expect(attr(log.attributes, 'requestId')).toEqual({ stringValue: 'req_1' });
    expect(attr(log.attributes, 'nested')).toEqual({ stringValue: '{"a":1}' });
    expect(toOtlpLog('not json')).toBeUndefined();

    const buffer = new OtlpLogBuffer();
    buffer.push(line);
    expect(buffer.take()).toEqual([]); // off: nothing is collected
    buffer.setMinLevel('error');
    buffer.push(line);
    expect(buffer.take()).toEqual([]);
    buffer.setMinLevel('info');
    buffer.push(line);
    expect(buffer.take()).toHaveLength(1);
  });
});

describe('traces, metrics and logs through the gateway', () => {
  const keyring = parseKeyring(generateKey());
  const pepper = 'p'.repeat(32);
  const KEY = 'dr-otlp-test-key-0001';
  const mock = buildMock();
  const received: Record<string, unknown[]> = { traces: [], metrics: [], logs: [] };
  const logs = new OtlpLogBuffer();
  let collector: Server;
  let gw: ReturnType<typeof buildGateway>;
  let base = '';

  beforeAll(async () => {
    collector = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const kind = (req.url ?? '').split('/').pop() ?? '';
        received[kind]?.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const ca = collector.address();
    const root = `http://127.0.0.1:${String(typeof ca === 'object' && ca ? ca.port : 0)}/v1`;
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
          type: 'openai',
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
          prefix: 'dr-otlp',
          organizationId: 'org',
          teamId: null,
          projectId: 'prj',
          enabled: true,
          expiresAt: null,
        },
      ],
      settings: {
        tracing: {
          enabled: true,
          endpoint: `${root}/traces`,
          sampleRatio: 1,
          metrics: { enabled: true, endpoint: `${root}/metrics`, intervalSeconds: 5 },
          logs: { enabled: true, endpoint: `${root}/logs`, level: 'info' },
        },
      },
    };
    const dataDir = await mkdtemp(join(tmpdir(), 'dirouter-otlp-'));
    await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
    const logger = createLogger({
      service: 'gateway',
      level: 'info',
      destination: {
        write: (line: string) => {
          logs.push(line);
        },
      },
    });
    gw = buildGateway({
      logger,
      keyring,
      pepper,
      dataDir,
      otlpLogs: logs,
      otlpTickMs: 100,
      emitUsage: () => undefined,
      onRequestComplete: (event) => {
        logger.info({ requestId: event.requestId, status: event.status }, 'request completed');
      },
    });
    await gw.start();
    await gw.otlp.tick(); // switches log collection on before the request
    await gw.app.listen({ port: 0, host: '127.0.0.1' });
    const ga = gw.app.server.address();
    base = `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}`;
  });

  afterAll(async () => {
    await gw.app.close();
    await mock.close();
    await new Promise((resolve) => collector.close(resolve));
  });

  it('exports an LLM call a GenAI backend recognizes, its metrics and its log line', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'gpt-x',
        max_tokens: 64,
        temperature: 0.2,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(res.status).toBe(200);
    const requestId = res.headers.get('x-request-id');
    await gw.flushTraces();

    const spans = (
      received.traces as { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] }[]
    ).flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
    const llm = spans.find((s) => s.kind === 3);
    expect(llm?.name).toBe('chat mock-small');
    expect(attr(llm?.attributes, 'gen_ai.operation.name')).toEqual({ stringValue: 'chat' });
    expect(attr(llm?.attributes, 'gen_ai.provider.name')).toEqual({ stringValue: 'openai' });
    expect(attr(llm?.attributes, 'gen_ai.request.model')).toEqual({ stringValue: 'mock-small' });
    expect(attr(llm?.attributes, 'gen_ai.request.max_tokens')).toEqual({ intValue: '64' });
    expect(attr(llm?.attributes, 'gen_ai.request.temperature')).toEqual({ doubleValue: 0.2 });
    expect(attr(llm?.attributes, 'gen_ai.response.model')).toBeDefined();
    expect(attr(llm?.attributes, 'gen_ai.response.finish_reasons')).toEqual({
      arrayValue: { values: [{ stringValue: 'stop' }] },
    });
    expect(Number(attr(llm?.attributes, 'gen_ai.usage.input_tokens')?.intValue)).toBeGreaterThan(0);
    expect(Number(attr(llm?.attributes, 'gen_ai.usage.output_tokens')?.intValue)).toBeGreaterThan(
      0,
    );
    expect(attr(llm?.attributes, 'server.address')).toEqual({ stringValue: '127.0.0.1' });
    // The original names stay by default.
    expect(attr(llm?.attributes, 'gateway.provider')).toEqual({ stringValue: 'oa' });
    const server = spans.find((s) => s.kind === 2);
    expect(server?.name).toBe('gateway.request');
    expect(attr(server?.attributes, 'gen_ai.request.model')).toEqual({ stringValue: 'gpt-x' });

    const exportedMetrics = () =>
      (
        received.metrics as {
          resourceMetrics: { scopeMetrics: { metrics: { name: string }[] }[] }[];
        }[]
      ).flatMap((b) =>
        b.resourceMetrics.flatMap((r) =>
          r.scopeMetrics.flatMap((s) => s.metrics.map((m) => m.name)),
        ),
      );
    // Usage is recorded when the request completes on the gateway, which can be just after the
    // client has its answer; export again until it is in (a slow CI runner hit this).
    for (let i = 0; i < 50 && !exportedMetrics().includes('gen_ai.client.token.usage'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await gw.flushTraces();
    }
    const metricNames = exportedMetrics();
    expect(metricNames).toContain('gen_ai.client.token.usage');
    expect(metricNames).toContain('gen_ai.client.operation.duration');
    expect(metricNames).toContain('dirouter_gateway_requests_total');
    expect(metricNames).toContain('dirouter_gateway_request_duration_seconds');

    const records = (
      received.logs as {
        resourceLogs: {
          scopeLogs: { logRecords: { body: { stringValue: string }; attributes: OtlpAttr[] }[] }[];
        }[];
      }[]
    ).flatMap((b) => b.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)));
    const completed = records.find((r) => r.body.stringValue === 'request completed');
    expect(attr(completed?.attributes, 'requestId')).toEqual({ stringValue: requestId });
  });
});
