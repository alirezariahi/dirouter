import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  type RawBodyRequest,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AccessGuard } from '../../auth/auth.guard.js';
import {
  ApiZodBody,
  ApiZodOk,
  ApiZodQuery,
  JsonListSchema,
  JsonObjectSchema,
  ZodPipe,
} from '../../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../../rbac/org.guard.js';
import { PlatformGuard } from '../platform.guard.js';
import { BillingSettings } from '../settings.js';
import { PaymentsService } from './payments.service.js';

export const PaymentBody = z.object({
  provider: z.enum(['zarinpal', 'stripe']),
  amountUsd: z
    .string()
    .trim()
    .regex(/^\d{1,10}(\.\d{1,2})?$/, 'a USD amount with at most 2 decimals'),
  /** Where to send the payer afterwards; its origin must be the dashboard or the portal. */
  returnUrl: z.url().max(2_000).optional(),
});
/** Query values arrive as anything (repeated keys become arrays); only a plain string counts. */
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });
const AdminListQuery = ListQuery.extend({
  status: z.enum(['pending', 'succeeded', 'failed', 'expired']).optional(),
});

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/wallet')
@UseGuards(AccessGuard, OrgGuard)
export class WalletPaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Get('payment-options')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  async options() {
    const s = await this.payments.publicSettings();
    return { providers: s.available, topup: s.topup, exchangeRates: s.exchangeRates };
  }

  @Post('payments')
  @RequirePermission('billing:write')
  @ApiZodBody(PaymentBody)
  @ApiZodOk(z.object({ paymentId: z.string(), redirectUrl: z.string() }))
  create(
    @Org() org: OrgContext,
    @Body(new ZodPipe(PaymentBody)) body: z.infer<typeof PaymentBody>,
  ) {
    return this.payments.create(org, body);
  }

  @Get('payments')
  @RequirePermission('billing:read')
  @ApiZodQuery(ListQuery)
  @ApiZodOk(JsonListSchema)
  list(@Org() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.payments.list(org.organizationId, q.limit);
  }

  @Get('payments/:id')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  get(@Org() org: OrgContext, @Param('id') id: string) {
    return this.payments.get(org.organizationId, id);
  }
}

/** Unauthenticated provider entry points; nothing here is trusted without asking the provider. */
@ApiTags('billing')
@Controller('payments')
export class PaymentCallbacksController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Get('zarinpal/callback')
  @Redirect()
  @ApiExcludeEndpoint()
  async zarinpal(@Query('Authority') authority: unknown, @Query('Status') status: unknown) {
    return {
      url: await this.payments.zarinpalCallback(text(authority), text(status)),
      statusCode: 302,
    };
  }

  @Get('stripe/return')
  @Redirect()
  @ApiExcludeEndpoint()
  async stripeReturn(@Query('payment') payment: unknown) {
    return { url: await this.payments.stripeReturn(text(payment)), statusCode: 302 };
  }

  @Post('stripe/webhook')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  stripeWebhook(
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Headers('stripe-signature') signature?: string,
  ) {
    return this.payments.stripeWebhook(req.rawBody, signature);
  }
}

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/billing')
@UseGuards(AccessGuard, OrgGuard, PlatformGuard)
export class BillingPaymentsAdminController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Get('payments')
  @RequirePermission('billing:read')
  @ApiZodQuery(AdminListQuery)
  @ApiZodOk(JsonListSchema)
  list(@Query(new ZodPipe(AdminListQuery)) q: z.infer<typeof AdminListQuery>) {
    return this.payments.listAll(q.status, q.limit);
  }

  @Post('payments/reconcile')
  @HttpCode(200)
  @RequirePermission('billing:write')
  @ApiZodOk(JsonObjectSchema)
  reconcile() {
    return this.payments.reconcileOnce({ force: true });
  }

  @Get('settings')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  settings() {
    return this.payments.publicSettings();
  }

  @Put('settings')
  @RequirePermission('billing:write')
  @ApiZodBody(BillingSettings)
  @ApiZodOk(JsonObjectSchema)
  putSettings(
    @Org() org: OrgContext,
    @Body(new ZodPipe(BillingSettings)) body: z.infer<typeof BillingSettings>,
  ) {
    return this.payments.putSettings(org, body);
  }
}
