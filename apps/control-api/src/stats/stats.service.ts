/**
 * آمار و لاگ برای داشبورد (کارت ۳.۱۰). KPI، سری زمانی و «پرمصرف‌ها» از جداول تجمیعی
 * (usage_hourly و usage_daily) خوانده می‌شوند؛ لاگ‌ها از request_log با صفحه‌بندی cursor پایدار
 * روی (created_at, id) و همیشه با بازهٔ زمانی تا پارتیشن‌ها هرس شوند. همه‌چیز به سازمانِ
 * تأییدشده در Guard محدود است.
 */
import { DiRouterError, prefixedId } from '@dirouter/shared';
import { Prisma } from '@dirouter/db';
import { Inject, Injectable } from '@nestjs/common';

import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';

/** مرزهای بالای سطل‌های latency_hist (ms)؛ سطل آخر یعنی بیشتر از 60s (migration usage_rollups). */
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

@Injectable()
export class StatsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  /** نودهای گیت‌وی از heartbeat روی Valkey (هر ۵ ثانیه، انقضای ۱۵ ثانیه). */
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

  /** ریست دستی (فقط OWNER و ADMIN): روی کانال سلامت منتشر و در audit log ثبت می‌شود. */
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

  /** بازه‌های بیش از ۷ روز از جدول روزانه خوانده می‌شوند. */
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

  async logs(
    ctx: OrgContext,
    r: Range,
    f: Filters & { status?: 'success' | 'error' | undefined; httpStatus?: number | undefined },
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
    if (cursor) {
      const c = decodeCursor(cursor);
      // (created_at, id) یکتاست؛ ردیف‌های تازهٔ بالای صفحه ترتیب صفحه‌های بعد را به هم نمی‌زنند.
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

  /** وضعیت breaker، cooldown و lockout از گیت‌وی (همگام بین replicaها)، فقط برای همین سازمان. */
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
