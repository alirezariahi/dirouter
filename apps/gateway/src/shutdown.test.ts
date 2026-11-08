/**
 * graceful shutdown (کارت ۵.۸): readyz=503 در drain، ادامهٔ سرویس تا خروج از چرخش Traefik،
 * انتظار برای streamهای باز و قطع کنترل‌شده بعد از سقف.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigSnapshotInput } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { createLogger, encrypt, generateKey, hashApiKey, parseKeyring } from '@dirouter/shared';
import { SseParser } from '@dirouter/translator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildGateway } from './server.js';

const keyring = parseKeyring(generateKey());
const pepper = 'p'.repeat(32);
const KEY = 'dr-shutdown-test-0001';
const mock = buildMock();
let mockRoot = '';
let dataDir = '';

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const ma = mock.server.address();
  mockRoot = `http://127.0.0.1:${String(typeof ma === 'object' && ma ? ma.port : 0)}`;
  const provider = (id: string, secret: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    type: 'openai-compatible' as const,
    name: id,
    baseUrl: `${mockRoot}/v1`,
    enabled: true,
    options: {},
    credentials: [
      { id: `${id}-k`, name: id, secret: encrypt(keyring, secret, `${id}-k`), enabled: true },
    ],
  });
  const model = (id: string, providerId: string) => ({
    id,
    organizationId: 'org',
    slug: id,
    providerId,
    upstreamModel: 'mock-small',
    enabled: true,
    pricing: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
    capabilities: {},
  });
  const snapshot: ConfigSnapshotInput = {
    schemaVersion: 1,
    version: 1,
    generatedAt: new Date().toISOString(),
    providers: [
      provider('fast', 'sk-x'),
      provider('one-second', 'mock:chunks=5,chunk_delay=200'),
      provider('endless', 'mock:chunks=100,chunk_delay=100'),
    ],
    models: [model('fast', 'fast'), model('one-second', 'one-second'), model('endless', 'endless')],
    combos: [],
    aliases: [],
    virtualKeys: [
      {
        id: 'vk',
        hash: hashApiKey(KEY, pepper),
        prefix: 'dr-shut',
        organizationId: 'org',
        teamId: null,
        projectId: 'prj',
        enabled: true,
        expiresAt: null,
      },
    ],
    settings: {},
  };
  dataDir = await mkdtemp(join(tmpdir(), 'dirouter-shutdown-'));
  await writeFile(join(dataDir, 'snapshot.json'), JSON.stringify(snapshot));
});

afterAll(() => mock.close());

async function startGateway() {
  const gw = buildGateway({
    logger: createLogger({ service: 'test', level: 'silent' }),
    keyring,
    pepper,
    dataDir,
    emitUsage: () => undefined,
  });
  await gw.start();
  await gw.app.listen({ port: 0, host: '127.0.0.1' });
  const ga = gw.app.server.address();
  return { gw, base: `http://127.0.0.1:${String(typeof ga === 'object' && ga ? ga.port : 0)}` };
}

const chat = (base: string, model: string, stream: boolean) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hi' }] }),
  });

async function sseData(res: Response): Promise<string[]> {
  const parser = new SseParser();
  return [...parser.feed(await res.text()), ...parser.flush()].map((e) => e.data);
}

describe('graceful shutdown', () => {
  it('keeps serving during the ready delay, finishes open streams, then closes', async () => {
    const { gw, base } = await startGateway();
    const stream = await chat(base, 'one-second', true);
    expect(stream.status).toBe(200);
    const body = sseData(stream);

    const drained = gw.drain({ readyDelayMs: 300, drainMs: 5_000 });
    // readyz فوراً 503 می‌شود تا Traefik replica را کنار بگذارد...
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: 'draining' });
    // ...ولی تا خروج از چرخش، درخواست تازه هنوز سرویس می‌گیرد و اتصالش بسته می‌شود.
    const late = await chat(base, 'fast', false);
    expect(late.status).toBe(200);
    expect(late.headers.get('connection')).toBe('close');

    const data = await body;
    expect(data.at(-1)).toBe('[DONE]');
    expect(data.some((d) => d.includes('"error"'))).toBe(false);
    expect(await drained).toEqual({ forced: 0 });
    expect(gw.inFlight).toBe(0);
    await expect(fetch(`${base}/readyz`)).rejects.toThrow();
  });

  it('a stream longer than the drain limit ends with a parsable shutdown error', async () => {
    const { gw, base } = await startGateway();
    const stream = await chat(base, 'endless', true);
    const body = sseData(stream);
    await new Promise((r) => setTimeout(r, 150));
    const started = Date.now();
    expect(await gw.drain({ readyDelayMs: 0, drainMs: 300 })).toEqual({ forced: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
    const data = await body;
    const last = JSON.parse(data.at(-1) ?? '{}') as { error?: { message: string } };
    expect(last.error?.message).toBe('gateway shutting down, retry the request');
    expect(data.filter((d) => d.includes('"choices"')).length).toBeGreaterThan(0);
  });

  it('a request still waiting on upstream when the limit hits gets a 503 to retry', async () => {
    await fetch(`${mockRoot}/__mock/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directives: 'ttft=3000' }),
    });
    try {
      const { gw, base } = await startGateway();
      const pending = chat(base, 'fast', false);
      await new Promise((r) => setTimeout(r, 100));
      expect(await gw.drain({ readyDelayMs: 0, drainMs: 200 })).toEqual({ forced: 1 });
      const res = await pending;
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /shutting down/,
      );
    } finally {
      await fetch(`${mockRoot}/__mock/reset`, { method: 'POST' });
    }
  });
});
