/**
 * Tags and cost centers in the worker (card 33.4): the writer keeps them on the request log and
 * the ledger, the rollup reports usage per tag and per cost center, and tag budgets are reconciled
 * from the ledger. Runs with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL.
 */
import {
  budgetCounterKey,
  budgetPeriodKey,
  USAGE_EVENT_SCHEMA_VERSION,
  type UsageEvent,
} from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { createLogger, ulid } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BudgetDb, reconcileBudgets } from './budgets.js';
import { type UsageDb, UsageBatchWriter } from './writer.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const RUN = Date.now().toString(36);
const ORG = `org_tags_${RUN}`;

const event = (n: number, tags: string[], costCenter: string | undefined): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: ulid(),
  idempotencyKey: `req_tag_${RUN}_${String(n)}`,
  requestId: `req_tag_${RUN}_${String(n)}`,
  occurredAt: new Date().toISOString(),
  gatewayInstance: 'gw-it',
  configVersion: 1,
  organizationId: ORG,
  teamId: null,
  projectId: 'prj_tag',
  virtualKeyId: 'vk_tag',
  ...(tags.length > 0 ? { tags } : {}),
  ...(costCenter ? { costCenter } : {}),
  inboundApi: 'openai.chat',
  requestedModel: 'gpt-tag',
  resolvedModelId: 'm_tag',
  providerId: 'p_tag',
  credentialId: 'c_tag',
  stream: false,
  status: 'success',
  httpStatus: 200,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: '1.00000000',
  usageEstimated: false,
  latencyMs: 100,
  attempts: [],
});

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('tags and cost centers in the worker', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 4 });
  const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
  const now = new Date();

  beforeAll(async () => {
    await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG.replaceAll('_', '-') } });
    await db.$queryRawUnsafe('SELECT dirouter_ensure_request_log_partitions(1)');
    const writer = new UsageBatchWriter({
      db: db as unknown as UsageDb,
      logger,
      batchSize: 10,
      flushMs: 10,
    });
    await Promise.all([
      writer.add(event(1, ['search', 'beta'], 'cc-ads')),
      writer.add(event(2, ['search'], 'cc-ads')),
      writer.add(event(3, [], 'cc-core')),
      writer.add(event(4, [], undefined)),
    ]);
    await writer.drain();
  });

  afterAll(async () => {
    for (const table of [
      'request_log',
      'usage_ledger',
      'usage_dimension_hourly',
      'usage_dimension_daily',
      'budgets',
    ])
      await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1`, ORG);
    await db.$disconnect();
    redis.disconnect();
  });

  it('keeps tags and the cost center on the request log and the ledger', async () => {
    const logs = await db.requestLog.findMany({
      where: { organizationId: ORG },
      orderBy: { id: 'asc' },
      select: { tags: true, costCenter: true },
    });
    expect(logs).toEqual([
      { tags: ['search', 'beta'], costCenter: 'cc-ads' },
      { tags: ['search'], costCenter: 'cc-ads' },
      { tags: [], costCenter: 'cc-core' },
      { tags: [], costCenter: null },
    ]);
    const ledger = await db.usageLedger.findMany({
      where: { organizationId: ORG },
      select: { tags: true, costCenter: true },
    });
    expect(ledger.filter((l) => l.tags.includes('search'))).toHaveLength(2);
  });

  it('reports usage per tag and per cost center; a request counts for each of its tags', async () => {
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    for (const h of [hour, new Date(hour.getTime() - 3_600_000)])
      await db.$queryRawUnsafe('SELECT dirouter_rollup_dimensions_hour($1::timestamptz)', h);
    await db.$queryRawUnsafe(
      'SELECT dirouter_rollup_dimensions_day($1::date)',
      now.toISOString().slice(0, 10),
    );
    const daily = await db.usageDimensionDaily.findMany({
      where: { organizationId: ORG },
      orderBy: [{ dimension: 'asc' }, { value: 'asc' }],
    });
    expect(daily.map((d) => [d.dimension, d.value, d.requests, Number(d.costUsd)])).toEqual([
      ['cost_center', 'cc-ads', 2, 2],
      ['cost_center', 'cc-core', 1, 1],
      ['tag', 'beta', 1, 1],
      ['tag', 'search', 2, 2],
    ]);
  });

  it('reconciles a tag budget from the ledger rows carrying the tag', async () => {
    const id = `bdg_tag_${RUN}`;
    await db.budget.create({
      data: {
        id,
        organizationId: ORG,
        scope: 'TAG',
        scopeId: 'search',
        period: 'MONTHLY',
        limitUsd: '100',
      },
    });
    await reconcileBudgets(db as unknown as BudgetDb, redis, logger, { now });
    expect(await redis.hget(budgetCounterKey(id, budgetPeriodKey('monthly', now)), 'usd')).toBe(
      '200000000',
    );
  });
});
