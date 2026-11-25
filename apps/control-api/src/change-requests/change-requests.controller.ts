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
import { ApiZodBody, ApiZodOk, ApiZodQuery, ZodPipe } from '../common/zod.js';
import { HumanOnly, Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { ChangeRequestsService } from './change-requests.service.js';

export const ChangeRequestView = z.object({
  id: z.string(),
  kind: z.string(),
  targetId: z.string().nullable(),
  summary: z.string(),
  payload: z.unknown(),
  status: z.enum(['pending', 'applied', 'failed', 'rejected', 'cancelled', 'expired']),
  requestedById: z.string(),
  /** The person behind a request made with a management token (that token's creator). */
  requestedByHumanId: z.string().nullable(),
  decidedById: z.string().nullable(),
  decidedAt: z.string().nullable(),
  reason: z.string().nullable(),
  error: z.string().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
const ListQuery = z.object({
  status: z.enum(['pending', 'applied', 'failed', 'rejected', 'cancelled', 'expired']).optional(),
});
const RejectBody = z.object({ reason: z.string().trim().max(500).optional() }).optional();

@ApiTags('change-requests')
@ApiBearerAuth()
@Controller('orgs/:orgId/change-requests')
@UseGuards(AccessGuard, OrgGuard)
export class ChangeRequestsController {
  constructor(@Inject(ChangeRequestsService) private readonly changes: ChangeRequestsService) {}

  @Get()
  @RequirePermission('audit:read')
  @ApiZodQuery(ListQuery)
  @ApiZodOk(z.array(ChangeRequestView))
  list(@Org() org: OrgContext, @Query(new ZodPipe(ListQuery)) query: z.infer<typeof ListQuery>) {
    return this.changes.list(org, query.status);
  }

  /** Applies the change as the approver; the requester cannot approve their own request. */
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('org:read')
  @HumanOnly()
  @ApiZodBody(z.object({}).optional())
  @ApiZodOk(ChangeRequestView)
  approve(@Org() org: OrgContext, @Param('id') id: string) {
    return this.changes.approve(org, id);
  }

  /** Rejects (another member) or cancels (the requester) a pending request. */
  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('org:read')
  @HumanOnly()
  @ApiZodBody(RejectBody)
  @ApiZodOk(ChangeRequestView)
  reject(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>,
  ) {
    return this.changes.reject(org, id, body?.reason);
  }
}
