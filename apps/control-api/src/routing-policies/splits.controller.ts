import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ApiZodQuery, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { range, RangeQuery } from './rules.controller.js';
import { TrafficSplitsService } from './splits.service.js';

const AutoRollbackBody = z.object({
  enabled: z.boolean().optional(),
  errorRate: z.number().gt(0).max(1).optional(),
  minRequests: z.int().min(1).max(100_000).optional(),
  windowSeconds: z.int().min(10).max(3_600).optional(),
});
const SplitBody = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  match: z.string().min(1).max(200).describe('the name clients ask for'),
  stable: z.string().min(1).max(200),
  canary: z.string().min(1).max(200),
  canaryPercent: z.number().min(0).max(100),
  stickiness: z.enum(['key', 'session', 'request']).optional(),
  autoRollback: AutoRollbackBody.nullable().optional().describe('null turns it off'),
});
const SplitPatch = SplitBody.extend({ state: z.literal('active').optional() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
const Split = z.object({
  id: z.string(),
  version: z.int(),
  name: z.string(),
  enabled: z.boolean(),
  match: z.string(),
  stable: z.string(),
  canary: z.string(),
  canaryPercent: z.number(),
  stickiness: z.enum(['key', 'session', 'request']),
  autoRollback: z
    .object({
      enabled: z.boolean(),
      errorRate: z.number(),
      minRequests: z.int(),
      windowSeconds: z.int(),
    })
    .nullable(),
  state: z.enum(['active', 'rolled_back']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const RollbackBody = z.object({
  toVersion: z
    .int()
    .positive()
    .optional()
    .describe('restore this version; without it everything goes back to stable'),
});
const Version = z.object({
  version: z.int(),
  reason: z.string(),
  config: z.record(z.string(), z.unknown()),
  createdById: z.string().nullable(),
  createdAt: z.string(),
});
const Branch = z.object({
  model: z.string(),
  requests: z.int(),
  errors: z.int(),
  errorRate: z.number(),
  avgLatencyMs: z.int().nullable(),
  p95LatencyMs: z.int().nullable(),
  avgTtftMs: z.int().nullable(),
  costUsd: z.string(),
  avgCostUsd: z.string(),
  tokens: z.int(),
});
const Report = z.object({
  id: z.string(),
  version: z.int(),
  state: z.string(),
  from: z.string(),
  to: z.string(),
  stable: Branch,
  canary: Branch,
});
const ReportQuery = RangeQuery.extend({ version: z.coerce.number().int().positive().optional() });

/** Canary and percentage traffic splits with versions (card 32.3). */
@ApiTags('routing policies')
@ApiBearerAuth()
@Controller('orgs/:orgId/routing/splits')
@UseGuards(AccessGuard, OrgGuard)
export class TrafficSplitsController {
  constructor(@Inject(TrafficSplitsService) private readonly service: TrafficSplitsService) {}

  @Get()
  @RequirePermission('models:read')
  @ApiZodOk(z.array(Split))
  list(@Org() org: OrgContext) {
    return this.service.list(org);
  }

  @Post()
  @RequirePermission('models:write')
  @ApiZodBody(SplitBody)
  @ApiZodOk(Split)
  create(@Org() org: OrgContext, @Body(new ZodPipe(SplitBody)) body: z.infer<typeof SplitBody>) {
    return this.service.create(org, body);
  }

  /** Every change is a new version; `state: 'active'` resumes a rolled-back split. */
  @Patch(':id')
  @RequirePermission('models:write')
  @ApiZodBody(SplitPatch)
  @ApiZodOk(Split)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(SplitPatch)) body: z.infer<typeof SplitPatch>,
  ) {
    return this.service.update(org, id, body);
  }

  @Post(':id/rollback')
  @HttpCode(200)
  @RequirePermission('models:write')
  @ApiZodBody(RollbackBody)
  @ApiZodOk(Split)
  rollback(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(RollbackBody)) body: z.infer<typeof RollbackBody>,
  ) {
    return this.service.rollback(org, id, body.toVersion);
  }

  @Get(':id/versions')
  @RequirePermission('models:read')
  @ApiZodOk(z.array(Version))
  versions(@Org() org: OrgContext, @Param('id') id: string) {
    return this.service.versions(org, id);
  }

  /** Stable versus canary: requests, errors, latency and cost in the range (default 24 hours). */
  @Get(':id/report')
  @RequirePermission('usage:read')
  @ApiZodQuery(ReportQuery)
  @ApiZodOk(Report)
  report(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>,
  ) {
    const { from, to } = range(q);
    return this.service.report(org, id, from, to, q.version);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('models:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.remove(org, id);
  }
}
