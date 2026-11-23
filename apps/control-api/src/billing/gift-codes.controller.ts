import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, JsonListSchema, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { GiftCodesService } from './gift-codes.service.js';
import { PlatformGuard } from './platform.guard.js';

export const BatchBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['gift', 'recharge']),
  amountUsd: z
    .string()
    .trim()
    .regex(/^\d{1,8}(\.\d{1,8})?$/)
    .refine((v) => Number(v) > 0, 'amount must be positive'),
  count: z.int().min(1).max(10_000),
  /** How many organizations may redeem each code; 1 = single use. */
  maxRedemptions: z.int().min(1).max(1_000_000).default(1),
  expiresAt: z.iso.datetime().optional(),
});
export const RedeemBody = z.object({ code: z.string().trim().min(4).max(64) });

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/billing/gift-batches')
@UseGuards(AccessGuard, OrgGuard, PlatformGuard)
export class GiftBatchesController {
  constructor(@Inject(GiftCodesService) private readonly codes: GiftCodesService) {}

  @Get()
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  list() {
    return this.codes.batches();
  }

  /** The response is the only time the codes are visible. */
  @Post()
  @RequirePermission('billing:write')
  @ApiZodBody(BatchBody)
  @ApiZodOk(JsonObjectSchema)
  create(@Org() org: OrgContext, @Body(new ZodPipe(BatchBody)) body: z.infer<typeof BatchBody>) {
    return this.codes.createBatch(org, body);
  }

  @Get(':id')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  get(@Param('id') id: string) {
    return this.codes.batch(id);
  }

  @Get(':id/redemptions')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  redemptions(@Param('id') id: string) {
    return this.codes.redemptions(id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('billing:write')
  @ApiZodOk(JsonObjectSchema)
  revoke(@Org() org: OrgContext, @Param('id') id: string) {
    return this.codes.revoke(org, id);
  }
}

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/wallet')
@UseGuards(AccessGuard, OrgGuard)
export class RedeemController {
  constructor(@Inject(GiftCodesService) private readonly codes: GiftCodesService) {}

  @Post('redeem')
  @HttpCode(200)
  @RequirePermission('billing:write')
  @ApiZodBody(RedeemBody)
  @ApiZodOk(JsonObjectSchema)
  redeem(@Org() org: OrgContext, @Body(new ZodPipe(RedeemBody)) body: z.infer<typeof RedeemBody>) {
    return this.codes.redeem(org, body.code);
  }
}
