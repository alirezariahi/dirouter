import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { createLogger } from '@dirouter/shared';
import { describe, expect, it } from 'vitest';

import { hourOf, toLedgerRow, toRequestLogRow, type UsageDb, UsageBatchWriter } from './writer.js';

const logger = createLogger({ service: 'test', level: 'silent' });

const event = (n: number, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: `01JABCDEFGHJKMNPQRSTVW${String(n).padStart(4, '0')}`,
  idempotencyKey: `req_${String(n)}`,
  requestId: `req_${String(n)}`,
  occurredAt: '2026-11-07T10:15:00.000Z',
  gatewayInstance: 'gw',
  configVersion: 3,
  organizationId: 'org',
  teamId: null,
  projectId: 'prj',
  virtualKeyId: 'vk',
  inboundApi: 'openai.chat',
  requestedModel: 'gpt',
  resolvedModelId: 'm1',
  providerId: 'p1',
  credentialId: 'c1',
  stream: true,
  status: 'success',
  httpStatus: 200,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    reasoningTokens: 1,
  },
  costUsd: '0.00001000',
  usageEstimated: false,
  latencyMs: 120,
  ttftMs: 40,
  attempts: [
    {
      providerId: 'p0',
      modelId: 'm0',
      credentialId: 'c0',
      outcome: 'error',
      httpStatus: 503,
      errorCode: 'server',
      latencyMs: 30,
      startedAt: '2026-11-07T10:14:59.900Z',
    },
  ],
  ...extra,
});

/** db ساختگی با رفتار ON CONFLICT DO NOTHING و امکان شکست برای رویداد خاص. */
function fakeDb(failFor = new Set<string>()) {
  const logs = new Map<string, unknown>();
  const ledger = new Map<string, unknown>();
  let transactions = 0;
  const db: UsageDb = {
    $transaction: async (ops) => {
      transactions++;
      await Promise.all(ops);
    },
    requestLog: {
      createMany: ({ data }) => {
        const rows = data as { id: string }[];
        if (rows.some((r) => failFor.has(r.id))) return Promise.reject(new Error('fk violation'));
        for (const r of rows) if (!logs.has(r.id)) logs.set(r.id, r);
        return Promise.resolve({ count: rows.length });
      },
    },
    usageLedger: {
      createMany: ({ data }) => {
        const rows = data as { requestId: string }[];
        if (rows.some((r) => failFor.has(r.requestId))) return Promise.reject(new Error('fk'));
        for (const r of rows) if (!ledger.has(r.requestId)) ledger.set(r.requestId, r);
        return Promise.resolve({ count: rows.length });
      },
    },
  };
  return { db, logs, ledger, transactions: () => transactions };
}

describe('usage batch writer', () => {
  it('maps every event field, including all attempts', () => {
    const row = toRequestLogRow(event(1));
    expect(row).toMatchObject({
      id: 'req_1',
      apiKeyId: 'vk',
      modelId: 'm1',
      cacheReadTokens: 2,
      reasoningTokens: 1,
      costUsd: '0.00001000',
      ttftMs: 40,
      configVersion: 3,
    });
    expect(row.attempts).toHaveLength(1);
    expect(row.createdAt.toISOString()).toBe('2026-11-07T10:15:00.000Z');
    expect(toLedgerRow(event(1))).toMatchObject({ requestId: 'req_1', tokens: 15 });
    expect(hourOf('2026-11-07T10:59:59.999Z')).toBe('2026-11-07T10:00:00.000Z');
  });

  it('writes concurrent events in one transaction and reports the touched hours', async () => {
    const f = fakeDb();
    const marked: string[] = [];
    const writer = new UsageBatchWriter({
      db: f.db,
      logger,
      batchSize: 100,
      flushMs: 10,
      onWritten: (hours) => {
        marked.push(...hours);
      },
    });
    await Promise.all(Array.from({ length: 50 }, (_, i) => writer.add(event(i))));
    expect(f.logs.size).toBe(50);
    expect(f.ledger.size).toBe(50);
    expect(f.transactions()).toBe(1);
    expect(marked).toEqual(['2026-11-07T10:00:00.000Z']);
  });

  it('flushes at the batch size without waiting for the timer', async () => {
    const f = fakeDb();
    const writer = new UsageBatchWriter({ db: f.db, logger, batchSize: 10, flushMs: 60_000 });
    await Promise.all(Array.from({ length: 25 }, (_, i) => writer.add(event(i))).slice(0, 20));
    expect(f.transactions()).toBe(2);
    await writer.drain();
    expect(f.logs.size).toBe(25);
  });

  it('duplicate events do not create duplicate rows', async () => {
    const f = fakeDb();
    const writer = new UsageBatchWriter({ db: f.db, logger, batchSize: 100, flushMs: 5 });
    await Promise.all([writer.add(event(1)), writer.add(event(1)), writer.add(event(2))]);
    await writer.add(event(1));
    expect(f.logs.size).toBe(2);
    expect(f.ledger.size).toBe(2);
  });

  it('isolates a bad event so the rest of the batch is written', async () => {
    const f = fakeDb(new Set(['req_3']));
    const writer = new UsageBatchWriter({ db: f.db, logger, batchSize: 100, flushMs: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => writer.add(event(i))),
    );
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(f.logs.size).toBe(5);
    expect(writer.failures).toBe(1);
  });
});
