/**
 * Canary and percentage traffic splits (card 32.3): CRUD where every change is a new version,
 * instant rollback (to stable, or to any earlier version), the automatic rollbacks the gateway
 * reports, and the stable-versus-canary comparison of latency, errors and cost.
 */
import { SPLIT_ROLLBACKS_KEY, SplitAutoRollback, SplitRollbackEvent } from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';
import type { Logger } from '@dirouter/shared';
import { prefixedId } from '@dirouter/shared';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../infra/prisma.service.js';
import { LOGGER } from '../infra/tokens.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { SnapshotService } from '../snapshot/snapshot.service.js';
import { assertRoutableName, invalid, notFound } from './targets.js';

export interface SplitInput {
  name: string;
  enabled?: boolean | undefined;
  match: string;
  stable: string;
  canary: string;
  canaryPercent: number;
  stickiness?: 'key' | 'session' | 'request' | undefined;
  autoRollback?: Partial<SplitAutoRollback> | null | undefined;
}

type Row = NonNullable<Awaited<ReturnType<PrismaService['client']['trafficSplit']['findFirst']>>>;

/** The routable part of a split, as stored with each version. */
function configOf(row: Row) {
  return {
    name: row.name,
    enabled: row.enabled,
    match: row.match,
    stable: row.stable,
    canary: row.canary,
    canaryPercent: Number(row.canaryPercent),
    stickiness: row.stickiness as 'key' | 'session' | 'request',
    autoRollback: (row.autoRollback ?? null) as SplitAutoRollback | null,
    state: row.state as 'active' | 'rolled_back',
  };
}
type Config = ReturnType<typeof configOf>;

export function viewSplit(row: Row) {
  return {
    id: row.id,
    version: row.version,
    ...configOf(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const ROLLBACK_POLL_MS = 3_000;

@Injectable()
export class TrafficSplitsService implements OnModuleInit, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  get db() {
    return this.prisma.client;
  }

  onModuleInit() {
    this.#timer = setInterval(() => {
      void this.consumeRollbacks().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'canary rollback queue could not be read');
      });
    }, ROLLBACK_POLL_MS);
    this.#timer.unref();
  }

  onModuleDestroy() {
    if (this.#timer) clearInterval(this.#timer);
  }

  async list(org: OrgContext) {
    const rows = await this.db.trafficSplit.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(viewSplit);
  }

  async #validate(org: OrgContext, input: Config) {
    if (input.stable === input.canary) throw invalid('stable and canary must differ');
    if (Math.round(input.canaryPercent * 100) !== input.canaryPercent * 100)
      throw invalid('canaryPercent: at most two decimals');
    await assertRoutableName(this.db, org.organizationId, input.stable, 'stable', {
      allowAuto: false,
    });
    await assertRoutableName(this.db, org.organizationId, input.canary, 'canary', {
      allowAuto: false,
    });
  }

  #rollback(value: SplitInput['autoRollback']): SplitAutoRollback | null {
    if (value === null) return null;
    return SplitAutoRollback.parse(value ?? {});
  }

  async create(org: OrgContext, input: SplitInput) {
    const config: Config = {
      name: input.name,
      enabled: input.enabled ?? true,
      match: input.match,
      stable: input.stable,
      canary: input.canary,
      canaryPercent: input.canaryPercent,
      stickiness: input.stickiness ?? 'key',
      autoRollback: this.#rollback(input.autoRollback),
      state: 'active',
    };
    await this.#validate(org, config);
    const clash = await this.db.trafficSplit.findFirst({
      where: { organizationId: org.organizationId, match: input.match },
      select: { id: true },
    });
    if (clash) throw invalid(`match: '${input.match}' already has a split`);
    const id = prefixedId('spl');
    const row = await this.db.$transaction(async (tx) => {
      const created = await tx.trafficSplit.create({
        data: { id, organizationId: org.organizationId, ...this.#data(config) },
      });
      await tx.trafficSplitVersion.create({
        data: this.#version(created, 'created', org.userId),
      });
      return created;
    });
    await this.#audit(org, 'traffic_split.created', id, { name: input.name });
    this.snapshots.schedule('traffic split created', 0);
    return viewSplit(row);
  }

  #data(config: Config) {
    return {
      name: config.name,
      enabled: config.enabled,
      match: config.match,
      stable: config.stable,
      canary: config.canary,
      canaryPercent: new Prisma.Decimal(config.canaryPercent),
      stickiness: config.stickiness,
      autoRollback: config.autoRollback === null ? Prisma.DbNull : config.autoRollback,
      state: config.state,
    };
  }

  #version(row: Row, reason: string, userId: string | null) {
    return {
      id: prefixedId('splv'),
      splitId: row.id,
      version: row.version,
      config: configOf(row) as unknown as Prisma.InputJsonObject,
      reason,
      createdById: userId,
    };
  }

  /** Writes `config` as the next version of the split, with the reason it was made. */
  async #next(
    org: Pick<OrgContext, 'organizationId'> & { userId: string | null },
    stored: Row,
    config: Config,
    reason: string,
  ) {
    const row = await this.db.$transaction(async (tx) => {
      const updated = await tx.trafficSplit.update({
        where: { id: stored.id, version: stored.version },
        data: { ...this.#data(config), version: { increment: 1 } },
      });
      await tx.trafficSplitVersion.create({ data: this.#version(updated, reason, org.userId) });
      return updated;
    });
    this.snapshots.schedule(`traffic split ${reason}`, 0);
    return row;
  }

  async update(org: OrgContext, id: string, patch: Partial<SplitInput> & { state?: 'active' }) {
    const stored = await this.#owned(org, id);
    const current = configOf(stored);
    const config: Config = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.stable !== undefined ? { stable: patch.stable } : {}),
      ...(patch.canary !== undefined ? { canary: patch.canary } : {}),
      ...(patch.canaryPercent !== undefined ? { canaryPercent: patch.canaryPercent } : {}),
      ...(patch.stickiness !== undefined ? { stickiness: patch.stickiness } : {}),
      ...(patch.autoRollback !== undefined
        ? { autoRollback: this.#rollback(patch.autoRollback) }
        : {}),
      // Changing the canary or its share, or resuming explicitly, re-arms a rolled-back split.
      state:
        patch.state === 'active' || patch.canary !== undefined || patch.canaryPercent !== undefined
          ? 'active'
          : current.state,
    };
    if (patch.match !== undefined && patch.match !== current.match)
      throw invalid('match cannot change; create another split');
    await this.#validate(org, config);
    const row = await this.#next(org, stored, config, 'updated');
    await this.#audit(org, 'traffic_split.updated', id, { fields: Object.keys(patch) });
    return viewSplit(row);
  }

  /**
   * Instant rollback: without `toVersion` everything goes back to stable (a new version in state
   * `rolled_back`); with it, that version's configuration becomes the newest version.
   */
  async rollback(org: OrgContext, id: string, toVersion?: number) {
    const stored = await this.#owned(org, id);
    let config: Config;
    let reason: string;
    if (toVersion === undefined) {
      config = { ...configOf(stored), state: 'rolled_back' };
      reason = 'rollback';
    } else {
      const old = await this.db.trafficSplitVersion.findUnique({
        where: { splitId_version: { splitId: id, version: toVersion } },
      });
      if (!old) throw notFound('split version');
      config = { ...(old.config as unknown as Config), match: stored.match };
      reason = 'restore';
    }
    const row = await this.#next(org, stored, config, reason);
    await this.#audit(org, `traffic_split.${reason}`, id, {
      from: stored.version,
      ...(toVersion !== undefined ? { toVersion } : {}),
    });
    return viewSplit(row);
  }

  async versions(org: OrgContext, id: string) {
    await this.#owned(org, id);
    const rows = await this.db.trafficSplitVersion.findMany({
      where: { splitId: id },
      orderBy: { version: 'desc' },
      take: 100,
    });
    return rows.map((v) => ({
      version: v.version,
      reason: v.reason,
      config: v.config as Record<string, unknown>,
      createdById: v.createdById,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  async remove(org: OrgContext, id: string) {
    await this.#owned(org, id);
    await this.db.trafficSplit.delete({ where: { id } });
    await this.#audit(org, 'traffic_split.deleted', id);
    this.snapshots.schedule('traffic split deleted', 0);
  }

  /** Latency, errors and cost of the two branches in the range, from the request log. */
  async report(org: OrgContext, id: string, from: Date, to: Date, version?: number) {
    const split = await this.#owned(org, id);
    const rows = await this.db.$queryRaw<
      {
        branch: string;
        requests: number;
        errors: number;
        avg_latency_ms: number | null;
        p95_latency_ms: number | null;
        avg_ttft_ms: number | null;
        cost_usd: string;
        tokens: bigint;
      }[]
    >`
      SELECT "policy"->'split'->>'branch' AS branch,
             count(*)::int AS requests,
             count(*) FILTER (WHERE "status" = 'error')::int AS errors,
             round(avg("latency_ms"))::int AS avg_latency_ms,
             round(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latency_ms"))::int AS p95_latency_ms,
             round(avg("ttft_ms"))::int AS avg_ttft_ms,
             coalesce(sum("cost_usd"), 0)::text AS cost_usd,
             coalesce(sum("input_tokens" + "output_tokens"), 0)::bigint AS tokens
      FROM "request_log"
      WHERE "organization_id" = ${org.organizationId}
        AND "policy" ? 'split'
        AND "policy"->'split'->>'id' = ${id}
        AND (${version ?? null}::int IS NULL OR ("policy"->'split'->>'version')::int = ${version ?? null}::int)
        AND "created_at" >= ${from} AND "created_at" < ${to}
      GROUP BY 1`;
    const branch = (name: 'stable' | 'canary') => {
      const r = rows.find((x) => x.branch === name);
      const requests = r?.requests ?? 0;
      const cost = Number(r?.cost_usd ?? 0);
      return {
        model: name === 'stable' ? split.stable : split.canary,
        requests,
        errors: r?.errors ?? 0,
        errorRate: requests > 0 ? Math.round(((r?.errors ?? 0) / requests) * 10_000) / 10_000 : 0,
        avgLatencyMs: r?.avg_latency_ms ?? null,
        p95LatencyMs: r?.p95_latency_ms ?? null,
        avgTtftMs: r?.avg_ttft_ms ?? null,
        costUsd: cost.toFixed(8),
        avgCostUsd: requests > 0 ? (cost / requests).toFixed(8) : '0.00000000',
        tokens: Number(r?.tokens ?? 0),
      };
    };
    return {
      id,
      version: split.version,
      state: split.state,
      from: from.toISOString(),
      to: to.toISOString(),
      stable: branch('stable'),
      canary: branch('canary'),
    };
  }

  /**
   * Automatic rollbacks reported by the gateway: each becomes a new `rolled_back` version of
   * the split, unless that version has already moved on (a person changed it meanwhile).
   */
  async consumeRollbacks(): Promise<number> {
    let applied = 0;
    for (let i = 0; i < 100; i++) {
      const raw = await this.valkey.client.rpop(SPLIT_ROLLBACKS_KEY);
      if (!raw) break;
      let parsed: SplitRollbackEvent;
      try {
        parsed = SplitRollbackEvent.parse(JSON.parse(raw));
      } catch {
        this.logger.warn('ignoring an invalid canary rollback event');
        continue;
      }
      const stored = await this.db.trafficSplit.findFirst({
        where: { id: parsed.splitId, organizationId: parsed.organizationId },
      });
      if (stored?.version !== parsed.version || stored.state !== 'active') continue;
      try {
        await this.#next(
          { organizationId: parsed.organizationId, userId: null },
          stored,
          { ...configOf(stored), state: 'rolled_back' },
          'auto_rollback',
        );
      } catch (error) {
        // Another replica wrote the next version first.
        if ((error as { code?: string }).code === 'P2025') continue;
        throw error;
      }
      await this.db.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: parsed.organizationId,
          actorUserId: null,
          action: 'traffic_split.auto_rollback',
          targetType: 'routing_policy',
          targetId: parsed.splitId,
          diff: { version: parsed.version, errorRate: parsed.errorRate, requests: parsed.requests },
        },
      });
      applied++;
    }
    return applied;
  }

  async #owned(org: OrgContext, id: string) {
    const row = await this.db.trafficSplit.findFirst({
      where: { id, organizationId: org.organizationId },
    });
    if (!row) throw notFound('traffic split');
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
