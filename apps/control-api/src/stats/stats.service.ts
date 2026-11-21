/**
 * Stats and logs for the dashboard (card 3.10). KPIs, time series, and "top consumers" are read from aggregate tables
 * (usage_hourly and usage_daily); logs come from request_log with stable cursor pagination
 * on (created_at, id), and always with a time range so partitions are pruned. Everything is scoped to the
 * organization verified by the Guard.
 */
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Prisma } from '@dirouter/db';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

/** Upper bounds of the latency_hist buckets (ms); the last bucket means over 60s (usage_rollups migration). */
const HIST_BOUNDS = [100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000];

export interface Range {
  from: Date;
  to: Date;
}
export interface Filters {
  projectId?: string | undefined;
  apiKeyId?: string | undefined;
  model?: string | undefined;
}

const num = (v: unknown) =>
  typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v ?? 0);
const usd = (v: unknown) =>
  v === null || v === undefined
    ? '0'
    : new Prisma.Decimal(v as string).toFixed(8).replace(/\.?0+$/, '') || '0';

export function percentile(hist: number[], p: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i] ?? 0;
    if (seen >= total * p) return HIST_BOUNDS[i] ?? HIST_BOUNDS.at(-1) ?? null;
  }
  return HIST_BOUNDS.at(-1) ?? null;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}
export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [t, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as [string, string];
    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime()) || typeof id !== 'string') throw new Error('bad');
    return { createdAt, id };
  } catch {
    throw new DiRouterError('validation_failed', { message: 'invalid cursor' });
  }
}

/** A `::text` decimal column as a string; anything unexpected reads as zero. */
const decimalText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '0';

@Injectable()
export class StatsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  /** Gateway nodes from heartbeats on Valkey (every 5 seconds, 15-second expiry). */
  async gatewayNodes() {
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await this.valkey.client.scan(
          cursor,
          'MATCH',
          'dirouter:gateway:node:*',
          'COUNT',
          100,
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      const values = keys.length ? await this.valkey.client.mget(...keys) : [];
      return values
        .filter((v): v is string => typeof v === 'string')
        .map(
          (v) =>
            JSON.parse(v) as {
              instance: string;
              configVersion: number;
              ready: boolean;
              lastSeen: string;
              startedAt: string;
            },
        )
        .sort((a, b) => a.instance.localeCompare(b.instance));
    } catch {
      return [];
    }
  }

  /** Manual reset (OWNER and ADMIN only): published on the health channel and recorded in the audit log. */
  async reset(ctx: OrgContext, scope: 'provider' | 'model' | 'credential', id: string) {
    const org = ctx.organizationId;
    const owned =
      scope === 'provider'
        ? await this.db.provider.findFirst({
            where: { id, organizationId: org },
            select: { id: true },
          })
        : scope === 'model'
          ? await this.db.model.findFirst({
              where: { id, organizationId: org },
              select: { id: true },
            })
          : await this.db.credential.findFirst({
              where: { id, provider: { organizationId: org } },
              select: { id: true },
            });
    if (!owned) throw new DiRouterError('not_found');
    const receivers = await this.valkey.client.publish(
      'dirouter:health',
      JSON.stringify({ from: 'control-api', change: { kind: 'reset', scope, id } }),
    );
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action: 'health.reset',
        targetType: scope,
        targetId: id,
        diff: { receivers },
      },
    });
    return { scope, id, gatewaysNotified: receivers };
  }

  get db() {
    return this.prisma.client;
  }

  #where(ctx: OrgContext, r: Range, f: Filters, table: 'h' | 'd') {
    const bucket =
      table === 'd'
        ? Prisma.sql`bucket >= ${r.from}::date AND bucket < ${r.to}::date + 1`
        : Prisma.sql`bucket >= date_trunc('hour', ${r.from}::timestamptz) AND bucket < ${r.to}::timestamptz`;
    const parts = [Prisma.sql`organization_id = ${ctx.organizationId}`, bucket];
    if (f.projectId) parts.push(Prisma.sql`project_id = ${f.projectId}`);
    if (f.apiKeyId) parts.push(Prisma.sql`api_key_id = ${f.apiKeyId}`);
    if (f.model) parts.push(Prisma.sql`model_slug = ${f.model}`);
    return Prisma.join(parts, ' AND ');
  }

  /** Ranges over 7 days are read from the daily table. */
  #table(r: Range): 'h' | 'd' {
    return r.to.getTime() - r.from.getTime() > 7 * 86_400_000 ? 'd' : 'h';
  }

  async overview(ctx: OrgContext, r: Range, f: Filters) {
    const t = this.#table(r);
    const table = t === 'd' ? Prisma.raw('usage_daily') : Prisma.raw('usage_hourly');
    const [row] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(sum(requests), 0) AS requests, coalesce(sum(errors), 0) AS errors,
             coalesce(sum(input_tokens), 0) AS input_tokens, coalesce(sum(output_tokens), 0) AS output_tokens,
             coalesce(sum(cache_read_tokens), 0) AS cache_read_tokens, coalesce(sum(cost_usd), 0)::text AS cost_usd,
             coalesce(sum(latency_ms_sum), 0) AS latency_ms_sum, coalesce(sum(ttft_ms_sum), 0) AS ttft_ms_sum,
             coalesce(sum(ttft_count), 0) AS ttft_count, dirouter_int_array_sum(latency_hist) AS hist,
             count(DISTINCT api_key_id) AS active_keys, count(DISTINCT model_slug) AS models
      FROM ${table} WHERE ${this.#where(ctx, r, f, t)}`;
    const requests = num(row?.requests);
    const hist = ((row?.hist as number[] | null) ?? []).map(Number);
    return {
      from: r.from.toISOString(),
      to: r.to.toISOString(),
      requests,
      errors: num(row?.errors),
      errorRate: requests ? num(row?.errors) / requests : 0,
      inputTokens: num(row?.input_tokens),
      outputTokens: num(row?.output_tokens),
      cacheReadTokens: num(row?.cache_read_tokens),
      costUsd: usd(row?.cost_usd),
      avgLatencyMs: requests ? Math.round(num(row?.latency_ms_sum) / requests) : null,
      avgTtftMs: num(row?.ttft_count)
        ? Math.round(num(row?.ttft_ms_sum) / num(row?.ttft_count))
        : null,
      latencyP50Ms: percentile(hist, 0.5),
      latencyP95Ms: percentile(hist, 0.95),
      latencyP99Ms: percentile(hist, 0.99),
      activeKeys: num(row?.active_keys),
      models: num(row?.models),
    };
  }

  async timeseries(ctx: OrgContext, r: Range, f: Filters, granularity: 'hour' | 'day') {
    const t = granularity === 'day' ? 'd' : 'h';
    const table = t === 'd' ? Prisma.raw('usage_daily') : Prisma.raw('usage_hourly');
    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT bucket, sum(requests) AS requests, sum(errors) AS errors,
             sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
             sum(cost_usd)::text AS cost_usd, sum(latency_ms_sum) AS latency_ms_sum
      FROM ${table} WHERE ${this.#where(ctx, r, f, t)}
      GROUP BY bucket ORDER BY bucket`;
    return {
      granularity,
      points: rows.map((p) => {
        const requests = num(p.requests);
        const b = p.bucket as Date;
        return {
          bucket: t === 'd' ? b.toISOString().slice(0, 10) : b.toISOString(),
          requests,
          errors: num(p.errors),
          inputTokens: num(p.input_tokens),
          outputTokens: num(p.output_tokens),
          costUsd: usd(p.cost_usd),
          avgLatencyMs: requests ? Math.round(num(p.latency_ms_sum) / requests) : null,
        };
      }),
    };
  }

  async top(
    ctx: OrgContext,
    r: Range,
    f: Filters,
    by: 'model' | 'key' | 'project' | 'provider',
    metric: 'cost' | 'requests',
    limit: number,
  ) {
    const t = this.#table(r);
    const table = t === 'd' ? Prisma.raw('usage_daily') : Prisma.raw('usage_hourly');
    const col = Prisma.raw(
      { model: 'model_slug', key: 'api_key_id', project: 'project_id', provider: 'provider_id' }[
        by
      ],
    );
    const order = metric === 'cost' ? Prisma.sql`sum(cost_usd)` : Prisma.sql`sum(requests)`;
    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${col} AS id, sum(requests) AS requests, sum(errors) AS errors,
             sum(input_tokens + output_tokens) AS tokens, sum(cost_usd)::text AS cost_usd
      FROM ${table} WHERE ${this.#where(ctx, r, f, t)}
      GROUP BY ${col} ORDER BY ${order} DESC NULLS LAST, ${col} LIMIT ${limit}`;
    return {
      by,
      metric,
      items: rows.map((x) => ({
        id: String(x.id),
        requests: num(x.requests),
        errors: num(x.errors),
        tokens: num(x.tokens),
        costUsd: usd(x.cost_usd),
      })),
    };
  }

  async ledger(ctx: OrgContext, r: Range, f: Filters, limit: number) {
    const rows = await this.prisma.client.usageLedger.findMany({
      where: {
        organizationId: ctx.organizationId,
        occurredAt: { gte: r.from, lt: r.to },
        ...(f.projectId ? { projectId: f.projectId } : {}),
        ...(f.apiKeyId ? { apiKeyId: f.apiKeyId } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
    return {
      rows: rows.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        projectId: row.projectId,
        apiKeyId: row.apiKeyId,
        teamId: row.teamId,
        tokens: row.tokens,
        costUsd: usd(row.costUsd),
        occurredAt: row.occurredAt.toISOString(),
      })),
    };
  }

  async logs(
    ctx: OrgContext,
    r: Range,
    f: Filters & {
      status?: 'success' | 'error' | undefined;
      httpStatus?: number | undefined;
      providerId?: string | undefined;
      minLatencyMs?: number | undefined;
      maxLatencyMs?: number | undefined;
      minCostUsd?: string | undefined;
      maxCostUsd?: string | undefined;
    },
    limit: number,
    cursor?: string,
  ) {
    const parts = [
      Prisma.sql`organization_id = ${ctx.organizationId}`,
      Prisma.sql`created_at >= ${r.from} AND created_at < ${r.to}`,
    ];
    if (f.projectId) parts.push(Prisma.sql`project_id = ${f.projectId}`);
    if (f.apiKeyId) parts.push(Prisma.sql`api_key_id = ${f.apiKeyId}`);
    if (f.model) parts.push(Prisma.sql`requested_model = ${f.model}`);
    if (f.status) parts.push(Prisma.sql`status = ${f.status}`);
    if (f.httpStatus) parts.push(Prisma.sql`http_status = ${f.httpStatus}`);
    if (f.providerId) parts.push(Prisma.sql`provider_id = ${f.providerId}`);
    if (f.minLatencyMs !== undefined) parts.push(Prisma.sql`latency_ms >= ${f.minLatencyMs}`);
    if (f.maxLatencyMs !== undefined) parts.push(Prisma.sql`latency_ms <= ${f.maxLatencyMs}`);
    if (f.minCostUsd) parts.push(Prisma.sql`cost_usd >= ${f.minCostUsd}`);
    if (f.maxCostUsd) parts.push(Prisma.sql`cost_usd <= ${f.maxCostUsd}`);
    if (cursor) {
      const c = decodeCursor(cursor);
      // (created_at, id) is unique; new rows at the top of the page do not disturb the order of later pages.
      parts.push(Prisma.sql`(created_at, id) < (${c.createdAt}, ${c.id})`);
    }
    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT id, created_at, project_id, api_key_id, requested_model, model_id, provider_id, stream, status,
             http_status, error_code, input_tokens, output_tokens, cost_usd::text AS cost_usd, usage_estimated,
             latency_ms, ttft_ms, jsonb_array_length(attempts) AS attempt_count
      FROM request_log WHERE ${Prisma.join(parts, ' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((x) => this.#logItem(x)),
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.created_at as Date, String(last.id)) : null,
    };
  }

  #logItem(x: Record<string, unknown>) {
    return {
      id: String(x.id),
      createdAt: (x.created_at as Date).toISOString(),
      projectId: String(x.project_id),
      apiKeyId: String(x.api_key_id),
      requestedModel: String(x.requested_model),
      modelId: (x.model_id as string | null) ?? null,
      providerId: (x.provider_id as string | null) ?? null,
      stream: Boolean(x.stream),
      status: String(x.status),
      httpStatus: num(x.http_status),
      errorCode: (x.error_code as string | null) ?? null,
      inputTokens: num(x.input_tokens),
      outputTokens: num(x.output_tokens),
      costUsd: usd(x.cost_usd),
      usageEstimated: Boolean(x.usage_estimated),
      latencyMs: num(x.latency_ms),
      ttftMs: x.ttft_ms === null ? null : num(x.ttft_ms),
      attemptCount: num(x.attempt_count),
    };
  }

  async log(ctx: OrgContext, id: string) {
    const row = await this.db.requestLog.findFirst({
      where: { id, organizationId: ctx.organizationId },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'Log entry not found' });
    return {
      ...this.#logItem({
        ...row,
        created_at: row.createdAt,
        project_id: row.projectId,
        api_key_id: row.apiKeyId,
        requested_model: row.requestedModel,
        model_id: row.modelId,
        provider_id: row.providerId,
        http_status: row.httpStatus,
        error_code: row.errorCode,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cost_usd: row.costUsd.toString(),
        usage_estimated: row.usageEstimated,
        latency_ms: row.latencyMs,
        ttft_ms: row.ttftMs,
        attempt_count: Array.isArray(row.attempts) ? row.attempts.length : 0,
      }),
      inboundApi: row.inboundApi,
      endUser: row.endUser,
      credentialId: row.credentialId,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
      configVersion: row.configVersion,
      gatewayInstance: row.gatewayInstance,
      attempts: row.attempts,
    };
  }

  /**
   * Ledger totals for the range (card 16.1). The cost page shows this next to the rollup total:
   * the ledger is the financial source of truth, so the two must agree once rollups caught up.
   */
  async ledgerTotal(ctx: OrgContext, r: Range, f: Filters) {
    const project = f.projectId ? Prisma.sql`AND "project_id" = ${f.projectId}` : Prisma.empty;
    const key = f.apiKeyId ? Prisma.sql`AND "api_key_id" = ${f.apiKeyId}` : Prisma.empty;
    // Same window as the rollup tables read by `overview` (whole days over 7 days, whole hours
    // otherwise); with a different window the two totals could never be compared.
    const window =
      this.#table(r) === 'd'
        ? Prisma.sql`"occurred_at" >= ${r.from}::date AND "occurred_at" < ${r.to}::date + 1`
        : Prisma.sql`"occurred_at" >= date_trunc('hour', ${r.from}::timestamptz) AND "occurred_at" < ${r.to}::timestamptz`;
    const [row] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*)::int AS entries, coalesce(sum("cost_usd"), 0)::text AS cost_usd,
             coalesce(sum("tokens"), 0)::bigint AS tokens
      FROM "usage_ledger"
      WHERE "organization_id" = ${ctx.organizationId} AND ${window} ${project} ${key}`;
    return {
      entries: Number(row?.entries ?? 0),
      costUsd: decimalText(row?.cost_usd),
      tokens: Number(row?.tokens ?? 0),
    };
  }

  /** Every budget of the organization with what was spent in its current period (UTC day/month). */
  async budgetStatus(ctx: OrgContext) {
    const rows = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT b."id", b."scope"::text AS scope, b."scope_id", b."period"::text AS period,
             b."limit_usd"::text AS limit_usd, b."limit_tokens"::text AS limit_tokens,
             s.spent_usd::text AS spent_usd, s.spent_tokens::text AS spent_tokens
      FROM "budgets" b
      CROSS JOIN LATERAL (
        SELECT coalesce(sum(l."cost_usd"), 0) AS spent_usd, coalesce(sum(l."tokens"), 0) AS spent_tokens
        FROM "usage_ledger" l
        WHERE l."organization_id" = b."organization_id"
          AND l."occurred_at" >= CASE WHEN b."period"::text = 'daily'
                THEN date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                ELSE date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END
          AND CASE b."scope"::text
                WHEN 'api_key' THEN l."api_key_id" = b."scope_id"
                WHEN 'project' THEN l."project_id" = b."scope_id"
                WHEN 'team' THEN l."team_id" = b."scope_id"
                ELSE false END
      ) s
      WHERE b."organization_id" = ${ctx.organizationId}
      ORDER BY b."scope", b."scope_id", b."period"`;
    return rows.map((row) => {
      const limitUsd = row.limit_usd === null ? null : decimalText(row.limit_usd);
      const spentUsd = decimalText(row.spent_usd);
      return {
        id: String(row.id),
        scope: String(row.scope) === 'api_key' ? 'key' : String(row.scope),
        scopeId: String(row.scope_id),
        period: String(row.period),
        limitUsd,
        limitTokens: row.limit_tokens === null ? null : Number(row.limit_tokens),
        spentUsd,
        spentTokens: Number(row.spent_tokens ?? 0),
        usedPercent:
          limitUsd && Number(limitUsd) > 0
            ? Math.round((Number(spentUsd) / Number(limitUsd)) * 1000) / 10
            : null,
      };
    });
  }

  /**
   * Cache effectiveness (cards 13.1-13.3): hit rate per cache kind, the provider cost the hits
   * avoided (tokens of the cached answer at the model's current price) and tokens removed by
   * context compression. Read from request_log, so the range is limited by its retention.
   */
  async cacheStats(ctx: OrgContext, range: Range, projectId?: string) {
    const project = projectId ? Prisma.sql`AND l."project_id" = ${projectId}` : Prisma.empty;
    const [totals] = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*)::int AS requests,
             count(*) FILTER (WHERE l."cache_hit")::int AS hits,
             coalesce(sum(l."saved_input_tokens"), 0)::bigint AS compressed_tokens
      FROM "request_log" l
      WHERE l."organization_id" = ${ctx.organizationId}
        AND l."created_at" >= ${range.from} AND l."created_at" < ${range.to} ${project}`;
    const kinds = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(l."cache_kind", 'exact') AS kind, count(*)::int AS hits,
             coalesce(sum(l."input_tokens"), 0)::bigint AS input_tokens,
             coalesce(sum(l."output_tokens"), 0)::bigint AS output_tokens,
             coalesce(sum(
               l."input_tokens"::numeric * coalesce(m."input_price", 0) / 1000000
               + l."output_tokens"::numeric * coalesce(m."output_price", 0) / 1000000
             ), 0)::text AS saved_usd
      FROM "request_log" l
      LEFT JOIN "models" m ON m."id" = l."model_id"
      WHERE l."organization_id" = ${ctx.organizationId} AND l."cache_hit"
        AND l."created_at" >= ${range.from} AND l."created_at" < ${range.to} ${project}
      GROUP BY 1 ORDER BY 1`;
    const requests = Number(totals?.requests ?? 0);
    const hits = Number(totals?.hits ?? 0);
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      requests,
      hits,
      hitRate: requests ? hits / requests : 0,
      compressedInputTokens: Number(totals?.compressed_tokens ?? 0),
      kinds: kinds.map((row) => ({
        kind: String(row.kind),
        hits: Number(row.hits),
        hitRate: requests ? Number(row.hits) / requests : 0,
        savedInputTokens: Number(row.input_tokens),
        savedOutputTokens: Number(row.output_tokens),
        savedUsd: String(row.saved_usd),
      })),
    };
  }

  /**
   * Routing dry-run (card 12.5): asks a gateway replica which candidates it would try for a model
   * right now and why the others are skipped. The organization is always forced to the caller's.
   */
  async simulateRoute(
    ctx: OrgContext,
    body: {
      model: string;
      virtualKeyId?: string | undefined;
      estimatedInputTokens?: number | undefined;
      maxOutputTokens?: number | undefined;
      sessionKey?: string | undefined;
    },
  ) {
    if (body.virtualKeyId) {
      const key = await this.db.apiKey.findFirst({
        where: { id: body.virtualKeyId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!key) throw new DiRouterError('not_found', { message: 'key not found', status: 404 });
    }
    const res = await fetch(
      `${this.env.GATEWAY_INTERNAL_URL.replace(/\/+$/, '')}/internal/routes/simulate`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.env.INTERNAL_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...body, organizationId: ctx.organizationId, p2c: true }),
        signal: AbortSignal.timeout(5_000),
      },
    ).catch(() => undefined);
    if (!res)
      throw new DiRouterError('service_unavailable', {
        message: 'gateway is not reachable',
        status: 503,
      });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // A routing error (model_not_found, no_available_provider, …) is a valid simulation result.
    return { ok: res.ok, status: res.status, ...payload };
  }

  /**
   * Uptime history from periodic health probes (card 12.3): per provider totals for the range and
   * hourly buckets for the chart. Only providers of this organization are visible.
   */
  async uptime(ctx: OrgContext, range: Range) {
    const totals = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT p."id" AS provider_id, p."slug", p."name",
             count(s."id")::int AS samples,
             count(s."id") FILTER (WHERE s."ok")::int AS ok,
             round(avg(s."latency_ms") FILTER (WHERE s."ok"))::int AS avg_latency_ms,
             max(s."checked_at") AS last_checked_at,
             max(s."checked_at") FILTER (WHERE s."ok") AS last_ok_at
      FROM "providers" p
      LEFT JOIN "provider_health_samples" s
        ON s."provider_id" = p."id"
       AND s."checked_at" >= ${range.from} AND s."checked_at" < ${range.to}
      WHERE p."organization_id" = ${ctx.organizationId} AND p."deleted_at" IS NULL
      GROUP BY p."id", p."slug", p."name"
      ORDER BY p."slug"`;
    const buckets = await this.db.$queryRaw<Record<string, unknown>[]>`
      SELECT s."provider_id", date_trunc('hour', s."checked_at") AS bucket,
             count(*)::int AS samples, count(*) FILTER (WHERE s."ok")::int AS ok
      FROM "provider_health_samples" s
      JOIN "providers" p ON p."id" = s."provider_id"
      WHERE p."organization_id" = ${ctx.organizationId}
        AND s."checked_at" >= ${range.from} AND s."checked_at" < ${range.to}
      GROUP BY s."provider_id", bucket
      ORDER BY bucket`;
    const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
    const pct = (ok: number, samples: number) =>
      samples > 0 ? Math.round((ok / samples) * 10_000) / 100 : null;
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      providers: totals.map((row) => {
        const samples = Number(row.samples ?? 0);
        const ok = Number(row.ok ?? 0);
        return {
          providerId: String(row.provider_id),
          slug: String(row.slug),
          name: String(row.name),
          samples,
          ok,
          uptimePercent: pct(ok, samples),
          avgLatencyMs: row.avg_latency_ms === null ? null : Number(row.avg_latency_ms),
          lastCheckedAt: iso(row.last_checked_at),
          lastOkAt: iso(row.last_ok_at),
          buckets: buckets
            .filter((b) => b.provider_id === row.provider_id)
            .map((b) => ({
              at: iso(b.bucket),
              samples: Number(b.samples),
              uptimePercent: pct(Number(b.ok), Number(b.samples)),
            })),
        };
      }),
    };
  }

  /** Breaker, cooldown, and lockout status from the gateway (synced across replicas), for this organization only. */
  async runtimeHealth(ctx: OrgContext) {
    const [providers, models] = await Promise.all([
      this.db.provider.findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        select: {
          id: true,
          slug: true,
          name: true,
          credentials: { select: { id: true, name: true, status: true } },
        },
      }),
      this.db.model.findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        select: { id: true, slug: true },
      }),
    ]);
    const res = await fetch(
      `${this.env.GATEWAY_INTERNAL_URL.replace(/\/+$/, '')}/internal/health`,
      {
        headers: { authorization: `Bearer ${this.env.INTERNAL_TOKEN}` },
        signal: AbortSignal.timeout(5_000),
      },
    ).catch(() => undefined);
    const report = res?.ok
      ? ((await res.json()) as {
          providers: {
            id: string;
            state: string;
            total: number;
            errors: number;
            reopensAt?: number;
          }[];
          models: {
            id: string;
            state: string;
            total: number;
            errors: number;
            reopensAt?: number;
          }[];
          credentials: {
            credentialId: string;
            cooldownUntil?: number;
            disabledUntil?: number;
            disabledReason?: string;
            lockouts: { modelId: string; until: number }[];
          }[];
        })
      : undefined;
    const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : null);
    const breaker = (
      list: typeof report extends undefined ? never : NonNullable<typeof report>['providers'],
      id: string,
    ) => {
      const b = list.find((x) => x.id === id);
      return b
        ? { state: b.state, total: b.total, errors: b.errors, reopensAt: iso(b.reopensAt) }
        : { state: 'closed', total: 0, errors: 0, reopensAt: null };
    };
    return {
      gatewayReachable: Boolean(report),
      nodes: await this.gatewayNodes(),
      providers: providers.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        breaker: report ? breaker(report.providers, p.id) : null,
        credentials: p.credentials.map((c) => {
          const h = report?.credentials.find((x) => x.credentialId === c.id);
          return {
            id: c.id,
            name: c.name,
            status: c.status,
            cooldownUntil: iso(h?.cooldownUntil),
            disabledUntil: iso(h?.disabledUntil),
            disabledReason: h?.disabledReason ?? null,
            lockouts: (h?.lockouts ?? []).map((l) => ({ modelId: l.modelId, until: iso(l.until) })),
          };
        }),
      })),
      models: models.map((m) => ({
        id: m.id,
        slug: m.slug,
        breaker: report ? breaker(report.models, m.id) : null,
      })),
    };
  }
}
