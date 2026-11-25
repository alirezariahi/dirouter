import { DiRouterError } from '@dirouter/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ApiZodQuery, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { StatsService } from './stats.service.js';

const MAX_RANGE_MS = 400 * 86_400_000;
const Base = z.object({
  from: z.iso.datetime().optional().describe('پیش‌فرض: ۲۴ ساعت پیش (لاگ‌ها: ۷ روز پیش)'),
  to: z.iso.datetime().optional().describe('پیش‌فرض: اکنون'),
  projectId: z.string().optional(),
  apiKeyId: z.string().optional(),
  model: z.string().optional().describe('نام درخواستی (مدل، alias یا combo)'),
});
export const RangeQuery = Base;
export const SeriesQuery = Base.extend({ granularity: z.enum(['hour', 'day']).default('hour') });
export const TopQuery = Base.extend({
  by: z.enum(['model', 'key', 'project', 'provider']).default('model'),
  metric: z.enum(['cost', 'requests']).default('cost'),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
export const LogsQuery = Base.extend({
  status: z.enum(['success', 'error']).optional(),
  httpStatus: z.coerce.number().int().min(100).max(599).optional(),
  providerId: z.string().optional(),
  minLatencyMs: z.coerce.number().int().min(0).optional(),
  maxLatencyMs: z.coerce.number().int().min(0).optional(),
  minCostUsd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/)
    .optional(),
  maxCostUsd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

function range(q: z.infer<typeof Base>, defaultMs: number) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaultMs);
  if (from >= to)
    throw new DiRouterError('validation_failed', { message: 'from must be before to' });
  if (to.getTime() - from.getTime() > MAX_RANGE_MS)
    throw new DiRouterError('validation_failed', { message: 'range is limited to 400 days' });
  return { from, to };
}
const filters = (q: z.infer<typeof Base>) => ({
  projectId: q.projectId,
  apiKeyId: q.apiKeyId,
  model: q.model,
});

const Overview = z.object({
  from: z.string(),
  to: z.string(),
  requests: z.int(),
  errors: z.int(),
  errorRate: z.number(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  cacheReadTokens: z.int(),
  costUsd: z.string(),
  avgLatencyMs: z.int().nullable(),
  avgTtftMs: z.int().nullable(),
  latencyP50Ms: z.int().nullable().describe('تقریبی (مرز بالای سطل هیستوگرام)'),
  latencyP95Ms: z.int().nullable(),
  latencyP99Ms: z.int().nullable(),
  activeKeys: z.int(),
  models: z.int(),
});
const Series = z.object({
  granularity: z.enum(['hour', 'day']),
  points: z.array(
    z.object({
      bucket: z.string(),
      requests: z.int(),
      errors: z.int(),
      inputTokens: z.int(),
      outputTokens: z.int(),
      costUsd: z.string(),
      avgLatencyMs: z.int().nullable(),
    }),
  ),
});
const Top = z.object({
  by: z.string(),
  metric: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      requests: z.int(),
      errors: z.int(),
      tokens: z.int(),
      costUsd: z.string(),
    }),
  ),
});
const LogItem = z.object({
  id: z.string(),
  createdAt: z.string(),
  projectId: z.string(),
  apiKeyId: z.string(),
  requestedModel: z.string(),
  modelId: z.string().nullable(),
  providerId: z.string().nullable(),
  stream: z.boolean(),
  status: z.string(),
  httpStatus: z.int(),
  errorCode: z.string().nullable(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  costUsd: z.string(),
  usageEstimated: z.boolean(),
  latencyMs: z.int(),
  ttftMs: z.int().nullable(),
  attemptCount: z.int(),
});
const Logs = z.object({ items: z.array(LogItem), nextCursor: z.string().nullable() });
const LogDetail = LogItem.extend({
  inboundApi: z.string(),
  endUser: z.string().nullable(),
  credentialId: z.string().nullable(),
  cacheReadTokens: z.int(),
  cacheWriteTokens: z.int(),
  reasoningTokens: z.int(),
  configVersion: z.int(),
  gatewayInstance: z.string(),
  attempts: z
    .unknown()
    .describe('همهٔ تلاش‌ها: provider، مدل، credential، نتیجه، status و latency'),
  routing: z
    .unknown()
    .describe('Auto-routing decision (card 20.4): alias, target, task type, source and reasons'),
  serviceTier: z.string().nullable().describe('service tier the request was priced at (31.5)'),
  routeDecision: z
    .unknown()
    .describe('Routing decision (cards 32.5 and 32.7): data policy and removed targets'),
  chargeUsd: z.string(),
});
const Breaker = z
  .object({ state: z.string(), total: z.int(), errors: z.int(), reopensAt: z.string().nullable() })
  .nullable();
export const ResetBody = z.object({
  scope: z.enum(['provider', 'model', 'credential']),
  id: z.string().min(1),
});
const Health = z.object({
  gatewayReachable: z.boolean(),
  nodes: z.array(
    z.object({
      instance: z.string(),
      configVersion: z.int(),
      ready: z.boolean(),
      lastSeen: z.string(),
      startedAt: z.string(),
    }),
  ),
  providers: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      breaker: Breaker,
      credentials: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.string(),
          cooldownUntil: z.string().nullable(),
          disabledUntil: z.string().nullable(),
          disabledReason: z.string().nullable(),
          lockouts: z.array(z.object({ modelId: z.string(), until: z.string().nullable() })),
        }),
      ),
    }),
  ),
  models: z.array(z.object({ id: z.string(), slug: z.string(), breaker: Breaker })),
});

const SimulateBody = z.object({
  model: z.string().min(1).max(200).describe('model slug, alias or combo slug'),
  virtualKeyId: z.string().optional().describe("apply this key's allowedModels"),
  estimatedInputTokens: z.coerce.number().int().nonnegative().optional(),
  maxOutputTokens: z.coerce.number().int().positive().optional(),
  sessionKey: z.string().max(200).optional(),
  provider: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "OpenRouter-style provider preferences, as a request's `provider` object (card 32.1)",
    ),
  models: z
    .array(z.string().min(1).max(256))
    .max(8)
    .optional()
    .describe('fallback models tried after `model` (card 32.1)'),
});

@ApiTags('stats & logs')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class StatsController {
  constructor(@Inject(StatsService) private readonly stats: StatsService) {}

  @Get('stats/overview')
  @RequirePermission('usage:read')
  @ApiZodQuery(RangeQuery)
  @ApiZodOk(Overview, 'KPIهای بازه از جدول تجمیعی')
  overview(@Org() org: OrgContext, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.stats.overview(org, range(q, 86_400_000), filters(q));
  }

  @Get('stats/timeseries')
  @RequirePermission('usage:read')
  @ApiZodQuery(SeriesQuery)
  @ApiZodOk(Series)
  timeseries(
    @Org() org: OrgContext,
    @Query(new ZodPipe(SeriesQuery)) q: z.infer<typeof SeriesQuery>,
  ) {
    return this.stats.timeseries(org, range(q, 86_400_000), filters(q), q.granularity);
  }

  @Get('stats/top')
  @RequirePermission('usage:read')
  @ApiZodQuery(TopQuery)
  @ApiZodOk(Top)
  top(@Org() org: OrgContext, @Query(new ZodPipe(TopQuery)) q: z.infer<typeof TopQuery>) {
    return this.stats.top(org, range(q, 86_400_000), filters(q), q.by, q.metric, q.limit);
  }

  @Get('logs')
  @RequirePermission('usage:read')
  @ApiZodQuery(LogsQuery)
  @ApiZodOk(Logs, 'جدیدترین اول؛ nextCursor برای صفحهٔ بعد')
  logs(@Org() org: OrgContext, @Query(new ZodPipe(LogsQuery)) q: z.infer<typeof LogsQuery>) {
    return this.stats.logs(
      org,
      range(q, 7 * 86_400_000),
      {
        ...filters(q),
        status: q.status,
        httpStatus: q.httpStatus,
        providerId: q.providerId,
        minLatencyMs: q.minLatencyMs,
        maxLatencyMs: q.maxLatencyMs,
        minCostUsd: q.minCostUsd,
        maxCostUsd: q.maxCostUsd,
      },
      q.limit,
      q.cursor,
    );
  }

  @Get('logs/:id')
  @RequirePermission('usage:read')
  @ApiZodOk(LogDetail)
  log(@Org() org: OrgContext, @Param('id') id: string) {
    return this.stats.log(org, id);
  }

  /** Cost page (card 16.1): overview + trend + top models + ledger rows. */
  @Get('stats/cost')
  @RequirePermission('usage:read')
  @ApiZodQuery(RangeQuery)
  @ApiZodOk(JsonObjectSchema)
  async cost(
    @Org() org: OrgContext,
    @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>,
  ) {
    const r = range(q, 30 * 86_400_000);
    const f = filters(q);
    const [overview, series, top, ledger, ledgerTotal, budgets] = await Promise.all([
      this.stats.overview(org, r, f),
      this.stats.timeseries(org, r, f, 'day'),
      this.stats.top(org, r, f, 'model', 'cost', 10),
      this.stats.ledger(org, r, f, 100),
      this.stats.ledgerTotal(org, r, f),
      this.stats.budgetStatus(org),
    ]);
    return { overview, series, top, ledger, ledgerTotal, budgets };
  }

  /** Analytics (card 16.4): KPIs plus breakdowns by model/key/project/provider. */
  @Get('stats/analytics')
  @RequirePermission('usage:read')
  @ApiZodQuery(SeriesQuery)
  @ApiZodOk(JsonObjectSchema)
  async analytics(
    @Org() org: OrgContext,
    @Query(new ZodPipe(SeriesQuery)) q: z.infer<typeof SeriesQuery>,
  ) {
    const r = range(q, 7 * 86_400_000);
    const f = filters(q);
    const [overview, series, byModel, byKey, byProject, byProvider] = await Promise.all([
      this.stats.overview(org, r, f),
      this.stats.timeseries(org, r, f, q.granularity),
      this.stats.top(org, r, f, 'model', 'requests', 10),
      this.stats.top(org, r, f, 'key', 'cost', 10),
      this.stats.top(org, r, f, 'project', 'cost', 10),
      this.stats.top(org, r, f, 'provider', 'cost', 10),
    ]);
    return { overview, series, byModel, byKey, byProject, byProvider };
  }

  /** Live view polling (card 16.3): recent request metadata and runtime health only. */
  @Get('stats/live')
  @RequirePermission('usage:read')
  @ApiZodOk(JsonObjectSchema)
  async live(@Org() org: OrgContext) {
    const now = new Date();
    const from = new Date(now.getTime() - 15 * 60_000);
    const [recent, health] = await Promise.all([
      this.stats.logs(org, { from, to: now }, {}, 50),
      this.stats.runtimeHealth(org),
    ]);
    return { generatedAt: now.toISOString(), recent, health };
  }

  @Get('stats/ledger')
  @RequirePermission('usage:read')
  @ApiZodQuery(RangeQuery)
  @ApiZodOk(JsonObjectSchema)
  ledger(@Org() org: OrgContext, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.stats.ledger(org, range(q, 7 * 86_400_000), filters(q), 200);
  }

  @Get('health/runtime')
  @RequirePermission('usage:read')
  @ApiZodOk(Health, 'breaker، cooldown و lockout هر provider، credential و مدل')
  health(@Org() org: OrgContext) {
    return this.stats.runtimeHealth(org);
  }

  @Get('stats/cache')
  @RequirePermission('usage:read')
  @ApiZodQuery(RangeQuery)
  @ApiZodOk(JsonObjectSchema)
  cache(@Org() org: OrgContext, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.stats.cacheStats(org, range(q, 7 * 86_400_000), q.projectId);
  }

  @Post('routes/simulate')
  @HttpCode(200)
  @RequirePermission('models:read')
  @ApiZodBody(SimulateBody)
  @ApiZodOk(JsonObjectSchema)
  simulate(
    @Org() org: OrgContext,
    @Body(new ZodPipe(SimulateBody)) body: z.infer<typeof SimulateBody>,
  ) {
    return this.stats.simulateRoute(org, body);
  }

  @Get('health/uptime')
  @RequirePermission('usage:read')
  @ApiZodQuery(RangeQuery)
  @ApiZodOk(JsonObjectSchema)
  uptime(@Org() org: OrgContext, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.stats.uptime(org, range(q, 86_400_000));
  }

  @Post('health/reset')
  @HttpCode(200)
  @RequirePermission('health:write')
  @ApiZodBody(ResetBody)
  @ApiZodOk(
    z.object({ scope: z.string(), id: z.string(), gatewaysNotified: z.int() }),
    'ریست breaker یا cooldown در همهٔ گیت‌وی‌ها',
  )
  reset(@Org() org: OrgContext, @Body(new ZodPipe(ResetBody)) body: z.infer<typeof ResetBody>) {
    return this.stats.reset(org, body.scope, body.id);
  }
}
