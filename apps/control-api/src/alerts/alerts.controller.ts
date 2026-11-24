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
import {
  ApiZodBody,
  ApiZodOk,
  ApiZodQuery,
  JsonListSchema,
  JsonObjectSchema,
  ZodPipe,
} from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { AlertsService, THRESHOLD_REQUIRED } from './alerts.service.js';

const ChannelType = z.enum(['webhook', 'slack', 'telegram', 'email']);
export const ChannelBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: ChannelType,
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
const ChannelPatch = ChannelBody.partial().refine((v) => Object.keys(v).length > 0, 'empty patch');

const RuleType = z.enum([
  'error_rate',
  'latency',
  'budget',
  'invalid_credential',
  'breaker_open',
  'queue_length',
]);
export const RuleBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: RuleType,
  threshold: z.number().nonnegative().optional(),
  windowMinutes: z.int().min(1).max(1440).optional(),
  silenceMinutes: z.int().min(1).max(10_080).optional(),
  channelId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});
/** Every rule type is evaluated by the worker (card 24.2); some need a threshold. */
export const RuleCreate = RuleBody.superRefine((rule, ctx) => {
  if (THRESHOLD_REQUIRED.has(rule.type) && rule.threshold === undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['threshold'],
      message: `rule type '${rule.type}' requires a threshold`,
    });
});
const RulePatch = RuleBody.partial().refine((v) => Object.keys(v).length > 0, 'empty patch');
const EventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  acknowledged: z.enum(['true', 'false']).optional(),
});

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('orgs/:orgId/alerts')
@UseGuards(AccessGuard, OrgGuard)
export class AlertsController {
  constructor(@Inject(AlertsService) private readonly service: AlertsService) {}

  @Get('channels')
  @RequirePermission('alerts:read')
  @ApiZodOk(JsonListSchema)
  channels(@Org() org: OrgContext) {
    return this.service.listChannels(org);
  }

  @Post('channels')
  @RequirePermission('alerts:write')
  @ApiZodBody(ChannelBody)
  @ApiZodOk(JsonObjectSchema)
  createChannel(
    @Org() org: OrgContext,
    @Body(new ZodPipe(ChannelBody)) body: z.infer<typeof ChannelBody>,
  ) {
    return this.service.createChannel(org, body);
  }

  @Patch('channels/:id')
  @RequirePermission('alerts:write')
  @ApiZodBody(ChannelPatch)
  @ApiZodOk(JsonObjectSchema)
  updateChannel(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ChannelPatch)) body: z.infer<typeof ChannelPatch>,
  ) {
    return this.service.updateChannel(org, id, body);
  }

  @Delete('channels/:id')
  @HttpCode(204)
  @RequirePermission('alerts:write')
  @ApiNoContentResponse()
  async removeChannel(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.removeChannel(org, id);
  }

  @Post('channels/:id/test')
  @HttpCode(200)
  @RequirePermission('alerts:write')
  @ApiZodOk(z.object({ ok: z.boolean(), status: z.int().optional(), error: z.string().optional() }))
  testChannel(@Org() org: OrgContext, @Param('id') id: string) {
    return this.service.testChannel(org, id);
  }

  @Get('rules')
  @RequirePermission('alerts:read')
  @ApiZodOk(JsonListSchema)
  rules(@Org() org: OrgContext) {
    return this.service.listRules(org);
  }

  @Post('rules')
  @RequirePermission('alerts:write')
  @ApiZodBody(RuleBody)
  @ApiZodOk(JsonObjectSchema)
  createRule(
    @Org() org: OrgContext,
    @Body(new ZodPipe(RuleCreate)) body: z.infer<typeof RuleBody>,
  ) {
    return this.service.createRule(org, body);
  }

  @Patch('rules/:id')
  @RequirePermission('alerts:write')
  @ApiZodBody(RulePatch)
  @ApiZodOk(JsonObjectSchema)
  updateRule(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(RulePatch)) body: z.infer<typeof RulePatch>,
  ) {
    return this.service.updateRule(org, id, body);
  }

  @Delete('rules/:id')
  @HttpCode(204)
  @RequirePermission('alerts:write')
  @ApiNoContentResponse()
  async removeRule(@Org() org: OrgContext, @Param('id') id: string) {
    await this.service.removeRule(org, id);
  }

  @Get('events')
  @RequirePermission('alerts:read')
  @ApiZodQuery(EventsQuery)
  @ApiZodOk(JsonListSchema)
  events(@Org() org: OrgContext, @Query(new ZodPipe(EventsQuery)) q: z.infer<typeof EventsQuery>) {
    return this.service.listEvents(
      org,
      q.limit,
      q.acknowledged ? q.acknowledged === 'true' : undefined,
    );
  }

  @Post('events/:id/ack')
  @HttpCode(200)
  @RequirePermission('alerts:write')
  @ApiZodOk(JsonObjectSchema)
  ack(@Org() org: OrgContext, @Param('id') id: string) {
    return this.service.ackEvent(org, id);
  }
}
