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
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, JsonListSchema, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { PlatformGuard } from './platform.guard.js';
import { PricingService } from './pricing.service.js';

const Multiplier = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,8})?$/)
  .refine((v) => Number(v) > 0, 'must be positive');
const Usd = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,8})?$/);

export const GroupBody = z.object({
  name: z.string().trim().min(1).max(100),
  multiplier: Multiplier,
  description: z.string().max(500).optional(),
});
const GroupPatch = z
  .object({
    name: z.string().trim().min(1).max(100),
    multiplier: Multiplier,
    description: z.string().max(500).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'empty patch');
export const PlanBody = z.object({
  name: z.string().trim().min(1).max(100),
  priceUsd: Usd,
  includedUsd: Usd,
  active: z.boolean().optional(),
});
const PlanPatch = PlanBody.partial().refine((v) => Object.keys(v).length > 0, 'empty patch');
const GroupAssignment = z.object({ customerGroupId: z.string().nullable() });
const SubscribeBody = z.object({ planId: z.string() });

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/billing')
@UseGuards(AccessGuard, OrgGuard, PlatformGuard)
export class PricingAdminController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  @Get('groups')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  groups() {
    return this.pricing.groups();
  }

  @Post('groups')
  @RequirePermission('billing:write')
  @ApiZodBody(GroupBody)
  @ApiZodOk(JsonObjectSchema)
  createGroup(
    @Org() org: OrgContext,
    @Body(new ZodPipe(GroupBody)) body: z.infer<typeof GroupBody>,
  ) {
    return this.pricing.createGroup(org, body);
  }

  @Patch('groups/:id')
  @RequirePermission('billing:write')
  @ApiZodBody(GroupPatch)
  @ApiZodOk(JsonObjectSchema)
  updateGroup(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(GroupPatch)) body: z.infer<typeof GroupPatch>,
  ) {
    return this.pricing.updateGroup(org, id, body);
  }

  @Delete('groups/:id')
  @HttpCode(204)
  @RequirePermission('billing:write')
  @ApiNoContentResponse()
  async deleteGroup(@Org() org: OrgContext, @Param('id') id: string) {
    await this.pricing.deleteGroup(org, id);
  }

  @Put('wallets/:customerOrgId/group')
  @RequirePermission('billing:write')
  @ApiZodBody(GroupAssignment)
  @ApiZodOk(JsonObjectSchema)
  assign(
    @Org() org: OrgContext,
    @Param('customerOrgId') customerOrgId: string,
    @Body(new ZodPipe(GroupAssignment)) body: z.infer<typeof GroupAssignment>,
  ) {
    return this.pricing.setOrganizationGroup(org, customerOrgId, body.customerGroupId);
  }

  @Get('plans')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  plans() {
    return this.pricing.plans();
  }

  /** Every customer's subscription with its plan and allowance (card 25.2). */
  @Get('subscriptions')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  subscriptions() {
    return this.pricing.subscriptions();
  }

  @Post('plans')
  @RequirePermission('billing:write')
  @ApiZodBody(PlanBody)
  @ApiZodOk(JsonObjectSchema)
  createPlan(@Org() org: OrgContext, @Body(new ZodPipe(PlanBody)) body: z.infer<typeof PlanBody>) {
    return this.pricing.createPlan(org, body);
  }

  @Patch('plans/:id')
  @RequirePermission('billing:write')
  @ApiZodBody(PlanPatch)
  @ApiZodOk(JsonObjectSchema)
  updatePlan(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(PlanPatch)) body: z.infer<typeof PlanPatch>,
  ) {
    return this.pricing.updatePlan(org, id, body);
  }
}

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/wallet')
@UseGuards(AccessGuard, OrgGuard)
export class SubscriptionController {
  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  @Get('plans')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  plans() {
    return this.pricing.plans(true);
  }

  @Get('subscription')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema.nullable())
  subscription(@Org() org: OrgContext) {
    return this.pricing.subscription(org.organizationId);
  }

  @Post('subscription')
  @RequirePermission('billing:write')
  @ApiZodBody(SubscribeBody)
  @ApiZodOk(JsonObjectSchema)
  subscribe(
    @Org() org: OrgContext,
    @Body(new ZodPipe(SubscribeBody)) body: z.infer<typeof SubscribeBody>,
  ) {
    return this.pricing.subscribe(org, body.planId);
  }

  @Delete('subscription')
  @RequirePermission('billing:write')
  @ApiZodOk(JsonObjectSchema)
  cancel(@Org() org: OrgContext) {
    return this.pricing.cancel(org);
  }
}
