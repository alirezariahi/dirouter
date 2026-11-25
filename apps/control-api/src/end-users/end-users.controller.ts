import { Body, Controller, Get, Inject, Param, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ApiZodQuery, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { EndUsersService } from './end-users.service.js';

export const EndUserListQuery = z.object({
  search: z.string().max(256).optional().describe('part of the end-user id'),
  blocked: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export const EndUserBody = z.object({ blocked: z.boolean() });
const Month = z.object({ requests: z.int(), costUsd: z.string() });
const EndUserItem = z.object({
  id: z.string(),
  blocked: z.boolean(),
  firstSeenAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  hasLimits: z.boolean(),
  month: Month,
});
const EndUserList = z.object({ total: z.int(), items: z.array(EndUserItem) });
const Budget = z.object({
  id: z.string(),
  period: z.string(),
  limitUsd: z.string().nullable(),
  limitTokens: z.int().nullable(),
  alertThresholds: z.array(z.int()),
});
const EndUserDetail = z.object({
  id: z.string(),
  blocked: z.boolean(),
  firstSeenAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  month: Month,
  limits: z.object({
    scope: z.string(),
    scopeId: z.string(),
    name: z.string(),
    rpm: z.int().nullable(),
    tpm: z.int().nullable(),
    maxConcurrency: z.int().nullable(),
    budgets: z.array(Budget),
  }),
  days: z.array(
    z.object({
      day: z.string(),
      requests: z.int(),
      errors: z.int(),
      tokens: z.int(),
      costUsd: z.string(),
    }),
  ),
});

/** End users of the organization's own product (card 33.2). */
@ApiTags('end users')
@ApiBearerAuth()
@Controller('orgs/:orgId/end-users')
@UseGuards(AccessGuard, OrgGuard)
export class EndUsersController {
  constructor(@Inject(EndUsersService) private readonly endUsers: EndUsersService) {}

  @Get()
  @RequirePermission('usage:read')
  @ApiZodQuery(EndUserListQuery)
  @ApiZodOk(EndUserList, 'End users seen most recently first, with this month’s usage')
  list(
    @Org() org: OrgContext,
    @Query(new ZodPipe(EndUserListQuery)) q: z.infer<typeof EndUserListQuery>,
  ) {
    return this.endUsers.list(org, q);
  }

  @Get(':endUser')
  @RequirePermission('usage:read')
  @ApiZodOk(EndUserDetail, 'One end user with its limits and the last 30 days of usage')
  get(@Org() org: OrgContext, @Param('endUser') endUser: string) {
    return this.endUsers.get(org, endUser);
  }

  @Put(':endUser')
  @RequirePermission('org:write')
  @ApiZodBody(EndUserBody)
  @ApiZodOk(EndUserDetail, 'Blocks or unblocks the end user (it need not have been seen yet)')
  set(
    @Org() org: OrgContext,
    @Param('endUser') endUser: string,
    @Body(new ZodPipe(EndUserBody)) body: z.infer<typeof EndUserBody>,
  ) {
    return this.endUsers.setBlocked(org, endUser, body.blocked);
  }
}
