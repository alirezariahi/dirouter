import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodOk, ApiZodQuery, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { UsageService } from './usage.service.js';

const UsageQuery = z.object({
  /** First UTC day, inclusive (default: 30 days before `to`). */
  from: z.iso.date().optional(),
  /** Day after the last one, exclusive (default: tomorrow). */
  to: z.iso.date().optional(),
});

/** The organization's own usage and what it cost (card 26.2): the portal's usage page. */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/usage')
@UseGuards(AccessGuard, OrgGuard)
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @Get()
  @RequirePermission('billing:read')
  @ApiZodQuery(UsageQuery)
  @ApiZodOk(JsonObjectSchema)
  get(@Org() org: OrgContext, @Query(new ZodPipe(UsageQuery)) q: z.infer<typeof UsageQuery>) {
    return this.usage.usage(org.organizationId, q.from, q.to);
  }
}
