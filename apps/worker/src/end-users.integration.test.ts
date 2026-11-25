/**
 * End users in the worker (card 33.2): the writer records them and their ledger rows, the rollup
 * keeps usage per end user with a cap of 1000 values per organization and hour, and default
 * end-user budgets are reconciled per end user. Runs with INTEGRATION_DATABASE_URL and
 * INTEGRATION_VALKEY_URL.
 */
import {
  budgetCounterKey,
  budgetPeriodKey,
  endUserCounterId,
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
} from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { createLogger, ulid } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BudgetDb, reconcileBudgets } from './budgets.js';
import { DIRTY_HOURS_KEY, rollup } from './maintenance.js';
import { type UsageDb, UsageBatchWriter } from './writer.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const RUN = Date.now().toString(36);
const ORG = `org_eu_${RUN}`;
const CAP_ORG = `org_eu_cap_${RUN}`;

const event = (n: number, endUser: string | undefined, at: Date): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: ulid(),
  idempotencyKey: `req_eu_${RUN}_${String(n)}`,
  requestId: `req_eu_${RUN}_${String(n)}`,
  occurredAt: at.toISOString(),
  gatewayInstance: 'gw-it',
  configVersion: 1,
  organizationId: ORG,
  teamId: null,
  projectId: 'prj_eu',
  virtualKeyId: 'vk_eu',
  ...(endUser ? { endUser } : {}),
  inboundApi: 'openai.chat',
  requestedModel: 'gpt-eu',
  resolvedModelId: 'm_eu',
  providerId: 'p_eu',
  credentialId: 'c_eu',
  stream: false,
  status: 'success',
  httpStatus: 200,
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: '0.25000000',
  usageEstimated: false,
  latencyMs: 300,
  attempts: [],
});

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('end users in the worker', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 4 });
  const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
  const now = new Date();
  const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

  beforeAll(async () => {
    for (const id of [ORG, CAP_ORG])
      await db.organization.create({ data: { id, name: id, slug: id.replaceAll('_', '-') } });
    await db.$queryRawUnsafe('SELECT dirouter_ensure_request_log_partitions(1)');
    await redis.del(DIRTY_HOURS_KEY);
  });

  afterAll(async () => {
    for (const table of [
      'request_log',
      'usage_ledger',
      'end_users',
      'usage_dimension_hourly',
      'usage_dimension_daily',
      'budgets',
    ])
      await db.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE organization_id IN ($1, $2)`,
        ORG,
        CAP_ORG,
      );
    await db.$disconnect();
    redis.disconnect();
  });

  it('records the end users a batch names, and the ledger keeps who each request was for', async () => {
    const writer = new UsageBatchWriter({
      db: db as unknown as UsageDb,
      logger,
      batchSize: 10,
      flushMs: 10,
    });
    const earlier = new Date(now.getTime() - 60_000);
    await Promise.all([
      writer.add(event(1, 'alice', earlier)),
      writer.add(event(2, 'alice', now)),
      writer.add(event(3, 'bob', now)),
      writer.add(event(4, undefined, now)),
    ]);
    await writer.drain();
    const users = await db.endUser.findMany({
      where: { organizationId: ORG },
      orderBy: { externalId: 'asc' },
    });
    expect(users.map((u) => u.externalId)).toEqual(['alice', 'bob']);
    expect(users[0]?.firstSeenAt?.toISOString()).toBe(earlier.toISOString());
    expect(users[0]?.lastSeenAt?.toISOString()).toBe(now.toISOString());
    const ledger = await db.usageLedger.findMany({
      where: { organizationId: ORG },
      select: { endUser: true },
    });
    expect(ledger.map((l) => l.endUser).sort()).toEqual(['alice', 'alice', 'bob', null]);

    // A second batch only moves last_seen_at.
    const later = new Date(now.getTime() + 1_000);
    await writer.add(event(5, 'alice', later));
    await writer.drain();
    const alice = await db.endUser.findUnique({
      where: { organizationId_externalId: { organizationId: ORG, externalId: 'alice' } },
    });
    expect(alice?.firstSeenAt?.toISOString()).toBe(earlier.toISOString());
    expect(alice?.lastSeenAt?.toISOString()).toBe(later.toISOString());
  });

  it('rolls usage up per end user, hourly and daily', async () => {
    await rollup(
      db,
      { sadd: (k, ...m) => redis.sadd(k, ...m), spop: (k, n) => redis.spop(k, n) },
      logger,
      now,
    );
    const hourly = await db.usageDimensionHourly.findMany({
      where: { organizationId: ORG, dimension: 'end_user' },
      orderBy: { value: 'asc' },
    });
    // Summed over hours: the first request may fall in the previous hour.
    const per = new Map<string, [number, number]>();
    for (const h of hourly) {
      const [requests, cost] = per.get(h.value) ?? [0, 0];
      per.set(h.value, [requests + h.requests, cost + Number(h.costUsd)]);
    }
    expect([...per.entries()]).toEqual([
      ['alice', [3, 0.75]],
      ['bob', [1, 0.25]],
    ]);
    const daily = await db.usageDimensionDaily.findMany({
      where: { organizationId: ORG, dimension: 'end_user' },
    });
    expect(daily.reduce((sum, d) => sum + d.requests, 0)).toBe(4);
  });

  it('keeps at most 1000 end users per organization and hour; the rest is __other__', async () => {
    // 1002 end users: one with three requests, 1001 with one.
    await db.$executeRawUnsafe(
      `INSERT INTO request_log (id, created_at, organization_id, project_id, api_key_id, end_user,
         inbound_api, requested_model, stream, status, http_status, input_tokens, output_tokens,
         cost_usd, latency_ms, config_version, gateway_instance)
       SELECT 'cap_' || $2 || '_' || n, $1::timestamptz, $3, 'prj', 'key',
              CASE WHEN n <= 3 THEN 'top' ELSE 'u' || lpad((n - 3)::text, 4, '0') END,
              'openai.chat', 'm', false, 'success', 200, 1, 1, 0.001, 10, 1, 'gw'
       FROM generate_series(1, 1004) AS n`,
      hour,
      RUN,
      CAP_ORG,
    );
    await db.$queryRawUnsafe('SELECT dirouter_rollup_dimensions_hour($1::timestamptz)', hour);
    const rows = await db.usageDimensionHourly.findMany({
      where: { organizationId: CAP_ORG, dimension: 'end_user', bucket: hour },
    });
    expect(new Set(rows.map((r) => r.value)).size).toBe(1001);
    expect(rows.find((r) => r.value === 'top')?.requests).toBe(3);
    expect(rows.find((r) => r.value === '__other__')?.requests).toBe(2);
    expect(rows.reduce((sum, r) => sum + r.requests, 0)).toBe(1004);
  });

  it('reconciles a default end-user budget on one counter per end user', async () => {
    const budgetId = `bdg_eu_${RUN}`;
    await db.budget.create({
      data: {
        id: budgetId,
        organizationId: ORG,
        scope: 'END_USER',
        scopeId: '*',
        period: 'DAILY',
        limitUsd: '10',
      },
    });
    await reconcileBudgets(db as unknown as BudgetDb, redis, logger, { now });
    const counter = (endUser: string) =>
      budgetCounterKey(endUserCounterId(budgetId, endUser), budgetPeriodKey('daily', now));
    expect(await redis.hget(counter('alice'), 'usd')).toBe('75000000');
    expect(await redis.hget(counter('bob'), 'usd')).toBe('25000000');
  });
});
