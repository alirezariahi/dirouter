/**
 * reconcile the budget counter against the ledger and record threshold alerts (card 6.3).
 * Runs with INTEGRATION_DATABASE_URL and INTEGRATION_VALKEY_URL set.
 */
import {
  BUDGET_ALERTS_KEY,
  type BudgetAlertEvent,
  budgetCounterKey,
  budgetPeriodKey,
} from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { createLogger } from '@dirouter/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BudgetDb, processBudgetAlerts, reconcileBudgets } from './budgets.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const VALKEY_URL = process.env.INTEGRATION_VALKEY_URL;
const logger = createLogger({ service: 'test', level: 'silent' });
const ORG = 'org_budget_it';
const RUN = Date.now().toString(36);

describe.skipIf(!DATABASE_URL || !VALKEY_URL)('budget reconcile on real services', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 2 });
  const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
  const now = new Date();
  const ids = { lost: `bdg_lost_${RUN}`, over: `bdg_over_${RUN}`, active: `bdg_active_${RUN}` };
  const key = (id: string, period: 'daily' | 'monthly' = 'daily') =>
    budgetCounterKey(id, budgetPeriodKey(period, now));

  beforeAll(async () => {
    await db.organization.upsert({
      where: { id: ORG },
      create: { id: ORG, name: 'Budget IT', slug: 'budget-it' },
      update: {},
    });
    await db.budget.deleteMany({ where: { organizationId: ORG } });
    await db.usageLedger.deleteMany({ where: { organizationId: ORG } });
    // three projects, each with a daily budget.
    for (const [name, id] of Object.entries(ids))
      await db.budget.create({
        data: {
          id,
          organizationId: ORG,
          scope: 'PROJECT',
          scopeId: `prj_${name}_${RUN}`,
          period: 'DAILY',
          limitUsd: '10',
        },
      });
    // ledger: each project has 4 requests × $0.25 and 100 tokens = $1 and 400 tokens today,
    // plus one row from yesterday that must not be counted.
    const rows = Object.keys(ids).flatMap((name) => [
      ...[0, 1, 2, 3].map((n) => ({
        id: `led_${name}_${String(n)}_${RUN}`,
        requestId: `req_${name}_${String(n)}_${RUN}`,
        organizationId: ORG,
        projectId: `prj_${name}_${RUN}`,
        apiKeyId: 'vk_it',
        costUsd: '0.25',
        tokens: 100,
        occurredAt: now,
      })),
      {
        id: `led_${name}_old_${RUN}`,
        requestId: `req_${name}_old_${RUN}`,
        organizationId: ORG,
        projectId: `prj_${name}_${RUN}`,
        apiKeyId: 'vk_it',
        costUsd: '5',
        tokens: 9_999,
        occurredAt: new Date(now.getTime() - 2 * 86_400_000),
      },
    ]);
    await db.usageLedger.createMany({ data: rows });
    await redis.del(key(ids.lost), key(ids.over), key(ids.active), BUDGET_ALERTS_KEY);
    // over: quiet counter above the ledger (e.g. an event that went to the DLQ).
    await redis.hset(
      key(ids.over),
      'usd',
      300_000_000,
      'tokens',
      9_000,
      'ts',
      now.getTime() - 600_000,
    );
    // active: just increased, above the ledger (events in flight) → must stay.
    await redis.hset(key(ids.active), 'usd', 150_000_000, 'tokens', 600, 'ts', now.getTime());
  });

  afterAll(async () => {
    await db.usageLedger.deleteMany({ where: { organizationId: ORG } });
    await db.budget.deleteMany({ where: { organizationId: ORG } });
    // audit_logs is append-only (database trigger), so its rows stay; the assertion below is
    // scoped to this run's budget id instead.
    await db.$disconnect();
    redis.disconnect();
  });

  it('lost counters come back from the ledger, quiet drift is corrected, in-flight is kept', async () => {
    const result = await reconcileBudgets(db as unknown as BudgetDb, redis, logger, { now });
    expect(result.budgets).toBeGreaterThanOrEqual(3);
    // $1 = 1e8 units
    expect(await redis.hmget(key(ids.lost), 'usd', 'tokens')).toEqual(['100000000', '400']);
    expect(await redis.hmget(key(ids.over), 'usd', 'tokens')).toEqual(['100000000', '400']);
    expect(await redis.hmget(key(ids.active), 'usd', 'tokens')).toEqual(['150000000', '600']);
    const adjusted = result.drift.map((d) => d.budgetId).sort();
    expect(adjusted).toEqual([ids.lost, ids.over].sort());
    expect(await redis.pttl(key(ids.lost))).toBeGreaterThan(86_400_000);
  });

  it('a second run changes nothing', async () => {
    const result = await reconcileBudgets(db as unknown as BudgetDb, redis, logger, { now });
    expect(result.drift.filter((d) => Object.values(ids).includes(d.budgetId))).toEqual([]);
  });

  it('threshold events become audit log rows', async () => {
    const event: BudgetAlertEvent = {
      budgetId: ids.active,
      organizationId: ORG,
      scope: 'project',
      scopeId: `prj_active_${RUN}`,
      period: 'daily',
      periodKey: budgetPeriodKey('daily', now),
      threshold: 80,
      kind: 'usd',
      spent: '8.00000000',
      limit: '10',
      at: now.toISOString(),
    };
    await redis.lpush(BUDGET_ALERTS_KEY, JSON.stringify(event), 'not json');
    expect(await processBudgetAlerts(db as unknown as BudgetDb, redis, logger)).toBe(1);
    const rows = await db.auditLog.findMany({
      where: { organizationId: ORG, action: 'budget.threshold_crossed', targetId: ids.active },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetType: 'budget',
      targetId: ids.active,
      actorUserId: null,
    });
    expect(rows[0]?.diff).toMatchObject({ threshold: 80, spent: '8.00000000', limit: '10' });
    expect(await redis.llen(BUDGET_ALERTS_KEY)).toBe(0);
  });
});

describe.skipIf(!DATABASE_URL || !VALKEY_URL)(
  'reconcile of organization, member, model and provider budgets (card 33.1)',
  () => {
    const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 2 });
    const redis = new Redis(VALKEY_URL ?? '', { maxRetriesPerRequest: null });
    const ORG2 = `org_scope_it_${RUN}`;
    const OTHER = `org_scope_other_${RUN}`;
    const now = new Date();
    const budgets = {
      organization: { id: `bdg_org_${RUN}`, scopeId: ORG2, period: 'WEEKLY' as const },
      user: { id: `bdg_usr_${RUN}`, scopeId: `usr_${RUN}`, period: 'YEARLY' as const },
      model: { id: `bdg_mdl_${RUN}`, scopeId: `mdl_${RUN}`, period: 'MONTHLY' as const },
      provider: { id: `bdg_prv_${RUN}`, scopeId: `prv_${RUN}`, period: 'DAILY' as const },
    };
    const counter = (b: { id: string; period: string }) =>
      budgetCounterKey(
        b.id,
        budgetPeriodKey(b.period.toLowerCase() as 'daily' | 'weekly' | 'monthly' | 'yearly', now),
      );

    beforeAll(async () => {
      for (const [id, slug] of [
        [ORG2, `scope-it-${RUN}`],
        [OTHER, `scope-other-${RUN}`],
      ] as const)
        await db.organization.create({ data: { id, name: id, slug } });
      await db.user.create({
        data: {
          id: `usr_${RUN}`,
          email: `u-${RUN}@scope.example.com`,
          name: 'u',
          passwordHash: 'not-a-real-hash',
        },
      });
      await db.project.create({
        data: { id: `prj_${RUN}`, organizationId: ORG2, name: 'p', slug: 'p' },
      });
      await db.apiKey.create({
        data: {
          id: `key_mine_${RUN}`,
          organizationId: ORG2,
          projectId: `prj_${RUN}`,
          name: 'mine',
          prefix: `dr-m${RUN}`,
          hash: `a${RUN}`.padEnd(64, '0'),
          createdById: `usr_${RUN}`,
        },
      });
      for (const [scope, b] of Object.entries(budgets))
        await db.budget.create({
          data: {
            id: b.id,
            organizationId: ORG2,
            scope: scope.toUpperCase() as 'ORGANIZATION',
            scopeId: b.scopeId,
            period: b.period,
            limitUsd: '100',
          },
        });
      const row = (id: string, extra: Record<string, unknown>) => ({
        id: `led_${id}_${RUN}`,
        requestId: `req_${id}_${RUN}`,
        organizationId: ORG2,
        projectId: `prj_${RUN}`,
        apiKeyId: 'vk_other',
        costUsd: '1',
        tokens: 10,
        occurredAt: now,
        ...extra,
      });
      await db.usageLedger.createMany({
        data: [
          // the member's key on the model and provider
          row('a', {
            apiKeyId: `key_mine_${RUN}`,
            modelId: `mdl_${RUN}`,
            providerId: `prv_${RUN}`,
          }),
          // another key of the organization on the same model and provider
          row('b', { modelId: `mdl_${RUN}`, providerId: `prv_${RUN}` }),
          // the organization on something else
          row('c', {}),
          // another tenant with the same model and provider ids never counts
          row('d', {
            organizationId: OTHER,
            modelId: `mdl_${RUN}`,
            providerId: `prv_${RUN}`,
          }),
        ],
      });
    });

    afterAll(async () => {
      await db.usageLedger.deleteMany({ where: { organizationId: { in: [ORG2, OTHER] } } });
      await db.budget.deleteMany({ where: { organizationId: ORG2 } });
      await db.$disconnect();
      redis.disconnect();
    });

    it('each scope is rebuilt from its own ledger rows within the organization and period', async () => {
      await reconcileBudgets(db as unknown as BudgetDb, redis, logger, { now });
      const usd = async (b: { id: string; period: string }) =>
        Number(await redis.hget(counter(b), 'usd')) / 100_000_000;
      expect(await usd(budgets.organization)).toBe(3);
      expect(await usd(budgets.user)).toBe(1);
      expect(await usd(budgets.model)).toBe(2);
      expect(await usd(budgets.provider)).toBe(2);
      expect(counter(budgets.organization)).toMatch(/:w:\d{4}-\d{2}-\d{2}$/);
      expect(counter(budgets.user)).toMatch(/:y:\d{4}$/);
    });
  },
);
