/**
 * Shadow traffic policies (card 32.4): CRUD and the shadow-versus-primary comparison. The copies
 * themselves live in `shadow_requests`, written by the worker; they are the organization's own
 * experiment and appear nowhere else (not in usage, invoices, budgets or wallets).
 */
import { shadowSpendKey, UsdAmount } from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import { prefixedId } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';
import { assertRoutableName, assertScope, invalid, notFound } from './targets.js';

export interface ShadowInput {
  name: string;
  enabled?: boolean | undefined;
  match: string;
  target: string;
  sampleRate: number;
  dailyBudgetUsd: string;
  projectId?: string | null | undefined;
  timeoutMs?: number | undefined;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['shadowPolicy']['findFirst']>>>;
const usd = (d: Prisma.Decimal) => d.toFixed(8).replace(/\.?0+$/, '') || '0';

export function viewShadow(row: Row) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    match: row.match,
    target: row.target,
    sampleRate: Number(row.sampleRate),
    dailyBudgetUsd: usd(row.dailyBudgetUsd),
    projectId: row.projectId,
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class ShadowPoliciesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  async list(org: OrgContext) {
    const rows = await this.db.shadowPolicy.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(viewShadow);
  }

  async #validate(
    org: OrgContext,
    input: Pick<ShadowInput, 'target' | 'dailyBudgetUsd' | 'projectId'>,
  ) {
    // Only the organization's own models: it pays its own provider for its own experiment.
    await assertRoutableName(this.db, org.organizationId, input.target, 'target', {
      ownOnly: true,
      allowAuto: false,
    });
    if (!UsdAmount.safeParse(input.dailyBudgetUsd).success || Number(input.dailyBudgetUsd) <= 0)
      throw invalid('dailyBudgetUsd: a positive dollar amount with at most 8 decimals');
    await assertScope(this.db, org.organizationId, { projectId: input.projectId });
  }

  async create(org: OrgContext, input: ShadowInput) {
    await this.#validate(org, input);
    const row = await this.db.shadowPolicy.create({
      data: {
        id: prefixedId('shd'),
        organizationId: org.organizationId,
        name: input.name,
        enabled: input.enabled ?? true,
        match: input.match,
        target: input.target,
        sampleRate: new Prisma.Decimal(input.sampleRate),
        dailyBudgetUsd: new Prisma.Decimal(input.dailyBudgetUsd),
        projectId: input.projectId ?? null,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
    });
    await this.#audit(org, 'shadow_policy.created', row.id, { name: row.name, target: row.target });
    this.snapshots.schedule('shadow policy created', 0);
    return viewShadow(row);
  }

  async update(org: OrgContext, id: string, patch: Partial<ShadowInput>) {
    const stored = await this.#owned(org, id);
    await this.#validate(org, {
      target: patch.target ?? stored.target,
      dailyBudgetUsd: patch.dailyBudgetUsd ?? usd(stored.dailyBudgetUsd),
      projectId: patch.projectId === undefined ? stored.projectId : patch.projectId,
    });
    const row = await this.db.shadowPolicy.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.match !== undefined ? { match: patch.match } : {}),
        ...(patch.target !== undefined ? { target: patch.target } : {}),
        ...(patch.sampleRate !== undefined
          ? { sampleRate: new Prisma.Decimal(patch.sampleRate) }
          : {}),
        ...(patch.dailyBudgetUsd !== undefined
          ? { dailyBudgetUsd: new Prisma.Decimal(patch.dailyBudgetUsd) }
          : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
        ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
      },
    });
    await this.#audit(org, 'shadow_policy.updated', id, { fields: Object.keys(patch) });
    this.snapshots.schedule('shadow policy updated', 0);
    return viewShadow(row);
  }

  async remove(org: OrgContext, id: string) {
    await this.#owned(org, id);
    await this.db.shadowPolicy.delete({ where: { id } });
    await this.#audit(org, 'shadow_policy.deleted', id);
    this.snapshots.schedule('shadow policy deleted', 0);
  }

  /** Shadow versus primary over the range, and today's shadow spend against the daily cap. */
  async report(org: OrgContext, id: string, from: Date, to: Date) {
    const policy = await this.#owned(org, id);
    const rows = await this.db.$queryRaw<
      {
        requests: number;
        errors: number;
        primary_errors: number;
        avg_latency_ms: number | null;
        avg_primary_latency_ms: number | null;
        p95_latency_ms: number | null;
        p95_primary_latency_ms: number | null;
        cost_usd: string;
        primary_cost_usd: string;
      }[]
    >`
      SELECT count(*)::int AS requests,
             count(*) FILTER (WHERE "status" = 'error')::int AS errors,
             count(*) FILTER (WHERE "primary_status" >= 400)::int AS primary_errors,
             round(avg("latency_ms"))::int AS avg_latency_ms,
             round(avg("primary_latency_ms"))::int AS avg_primary_latency_ms,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latency_ms"))::int AS p95_latency_ms,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY "primary_latency_ms"))::int AS p95_primary_latency_ms,
             coalesce(sum("cost_usd"), 0)::text AS cost_usd,
             coalesce(sum("primary_cost_usd"), 0)::text AS primary_cost_usd
      FROM "shadow_requests"
      WHERE "organization_id" = ${org.organizationId} AND "policy_id" = ${id}
        AND "created_at" >= ${from} AND "created_at" < ${to}`;
    const r = rows[0];
    const day = new Date().toISOString().slice(0, 10);
    const spentUnits = Number(
      (await this.valkey.client.get(shadowSpendKey(id, day)).catch(() => null)) ?? 0,
    );
    const requests = r?.requests ?? 0;
    return {
      id,
      from: from.toISOString(),
      to: to.toISOString(),
      requests,
      shadow: {
        model: policy.target,
        errors: r?.errors ?? 0,
        errorRate: requests > 0 ? Math.round(((r?.errors ?? 0) / requests) * 10_000) / 10_000 : 0,
        avgLatencyMs: r?.avg_latency_ms ?? null,
        p95LatencyMs: r?.p95_latency_ms ?? null,
        costUsd: Number(r?.cost_usd ?? 0).toFixed(8),
      },
      primary: {
        errors: r?.primary_errors ?? 0,
        avgLatencyMs: r?.avg_primary_latency_ms ?? null,
        p95LatencyMs: r?.p95_primary_latency_ms ?? null,
        costUsd: Number(r?.primary_cost_usd ?? 0).toFixed(8),
      },
      today: {
        spentUsd: (spentUnits / 100_000_000).toFixed(8),
        dailyBudgetUsd: usd(policy.dailyBudgetUsd),
        capped: spentUnits >= Number(policy.dailyBudgetUsd) * 100_000_000,
      },
    };
  }

  async #owned(org: OrgContext, id: string) {
    const row = await this.db.shadowPolicy.findFirst({
      where: { id, organizationId: org.organizationId },
    });
    if (!row) throw notFound('shadow policy');
    return row;
  }

  async #audit(org: OrgContext, action: string, targetId: string, diff?: object) {
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action,
        targetType: 'routing_policy',
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }
}
