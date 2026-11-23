import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
import { PlatformGuard } from './platform.guard.js';
import { WalletsService } from './wallets.service.js';

/** Signed USD amount with up to 8 decimals (the ledger's precision). */
export const UsdString = z
  .string()
  .trim()
  .regex(/^-?\d{1,10}(\.\d{1,8})?$/, 'a USD amount with at most 8 decimals');

const StatementQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.iso.datetime().optional(),
});
export const AdjustmentBody = z.object({
  amountUsd: UsdString.refine((v) => !/^-?0+(\.0+)?$/.test(v), 'amount cannot be zero'),
  reason: z.string().trim().min(3).max(500),
  /** Client-chosen; posting the same key twice changes nothing the second time. */
  idempotencyKey: z.string().trim().min(8).max(100),
});
export const PrepaidBody = z.object({ prepaid: z.boolean() });

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/wallet')
@UseGuards(AccessGuard, OrgGuard)
export class WalletController {
  constructor(@Inject(WalletsService) private readonly wallets: WalletsService) {}

  @Get()
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  summary(@Org() org: OrgContext) {
    return this.wallets.summary(org.organizationId);
  }

  @Get('statement')
  @RequirePermission('billing:read')
  @ApiZodQuery(StatementQuery)
  @ApiZodOk(JsonListSchema)
  statement(
    @Org() org: OrgContext,
    @Query(new ZodPipe(StatementQuery)) q: z.infer<typeof StatementQuery>,
  ) {
    return this.wallets.statement(org.organizationId, q.limit, q.before);
  }
}

/** Operator routes: only on the platform organization (PlatformGuard). */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/billing')
@UseGuards(AccessGuard, OrgGuard, PlatformGuard)
export class BillingAdminController {
  constructor(@Inject(WalletsService) private readonly wallets: WalletsService) {}

  @Get('wallets')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  list() {
    return this.wallets.listWallets();
  }

  @Get('wallets/:customerOrgId')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  wallet(@Param('customerOrgId') customerOrgId: string) {
    return this.wallets.summary(customerOrgId);
  }

  @Get('wallets/:customerOrgId/statement')
  @RequirePermission('billing:read')
  @ApiZodQuery(StatementQuery)
  @ApiZodOk(JsonListSchema)
  customerStatement(
    @Param('customerOrgId') customerOrgId: string,
    @Query(new ZodPipe(StatementQuery)) q: z.infer<typeof StatementQuery>,
  ) {
    return this.wallets.statement(customerOrgId, q.limit, q.before);
  }

  @Patch('wallets/:customerOrgId')
  @RequirePermission('billing:write')
  @ApiZodBody(PrepaidBody)
  @ApiZodOk(JsonObjectSchema)
  setPrepaid(
    @Org() org: OrgContext,
    @Param('customerOrgId') customerOrgId: string,
    @Body(new ZodPipe(PrepaidBody)) body: z.infer<typeof PrepaidBody>,
  ) {
    return this.wallets.setPrepaid(org, customerOrgId, body.prepaid);
  }

  @Post('wallets/:customerOrgId/adjustments')
  @RequirePermission('billing:write')
  @ApiZodBody(AdjustmentBody)
  @ApiZodOk(JsonObjectSchema)
  adjust(
    @Org() org: OrgContext,
    @Param('customerOrgId') customerOrgId: string,
    @Body(new ZodPipe(AdjustmentBody)) body: z.infer<typeof AdjustmentBody>,
  ) {
    return this.wallets.adjust(org, customerOrgId, body);
  }

  @Get('ledger/check')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  ledgerCheck() {
    return this.wallets.ledgerCheck();
  }
}
