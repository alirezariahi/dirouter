import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
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
import { invoiceView, InvoicesService } from './invoices.service.js';
import { PlatformGuard } from './platform.guard.js';

const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
const Day = z.iso.date();
const PeriodQuery = z.object({ period: Period.optional() });
const GenerateQuery = z.object({ period: Period });
const ProfitQuery = z.object({
  from: Day,
  to: Day,
  /** One customer organization (card 25.2). */
  organizationId: z.string().trim().min(1).max(100).optional(),
  /** One model slug (card 25.2). */
  model: z.string().trim().min(1).max(200).optional(),
});

/** Persian or Arabic-Indic digits to ASCII, so `۱۲۳` and `123` are the same identifier. */
const asciiDigits = (s: string) =>
  s.replace(/[\u06F0-\u06F9\u0660-\u0669]/g, (d) => String((d.codePointAt(0) ?? 0) & 0xf));
const Digits = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .transform(asciiDigits)
    .pipe(z.string().regex(new RegExp(`^\\d{${String(min)},${String(max)}}$`), label))
    .nullish();
const Text = (max: number) => z.string().trim().min(1).max(max).nullish();

/** Legal details printed on invoices (card 26.1). */
export const BillingProfileBody = z
  .object({
    /** legal: a company (11-digit national ID); natural: a person (10-digit national code). */
    partyType: z.enum(['legal', 'natural']).default('legal'),
    legalName: z.string().trim().min(2).max(200),
    nationalId: Digits(10, 11, 'a national ID of 11 digits or a national code of 10'),
    economicCode: Digits(10, 14, 'an economic code of 10 to 14 digits'),
    registrationNumber: Text(50),
    address: Text(500),
    postalCode: Digits(10, 10, 'a postal code of 10 digits'),
    phone: Text(30),
  })
  .refine((p) => !p.nationalId || p.nationalId.length === (p.partyType === 'legal' ? 11 : 10), {
    message: 'a company has an 11-digit national ID, a person a 10-digit national code',
    path: ['nationalId'],
  });

async function sendPdf(reply: FastifyReply, file: { filename: string; body: Buffer }) {
  await reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `attachment; filename="${file.filename}"`)
    .header('cache-control', 'private, no-store')
    .send(file.body);
}

@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/invoices')
@UseGuards(AccessGuard, OrgGuard)
export class InvoicesController {
  constructor(@Inject(InvoicesService) private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermission('billing:read')
  @ApiZodOk(JsonListSchema)
  list(@Org() org: OrgContext) {
    return this.invoices.list(org.organizationId);
  }

  /** Month to date, as the next invoice will show it (not stored). */
  @Get('preview')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  preview(@Org() org: OrgContext) {
    return this.invoices.preview(org.organizationId);
  }

  @Get(':id')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  async get(@Org() org: OrgContext, @Param('id') id: string) {
    return invoiceView(await this.invoices.get(id, org.organizationId));
  }

  @Get(':id/pdf')
  @RequirePermission('billing:read')
  @ApiProduces('application/pdf')
  @ApiZodOk(z.string(), 'PDF')
  async pdf(@Org() org: OrgContext, @Param('id') id: string, @Res() reply: FastifyReply) {
    await sendPdf(reply, await this.invoices.pdf(id, org.organizationId));
  }
}

/**
 * The organization's legal details printed on its invoices: the buyer's for a customer, the
 * seller's for the platform organization (card 26.1). Changes apply to invoices issued afterwards;
 * an issued invoice keeps the details it was issued with.
 */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/billing-profile')
@UseGuards(AccessGuard, OrgGuard)
export class BillingProfileController {
  constructor(@Inject(InvoicesService) private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  async get(@Org() org: OrgContext) {
    return (await this.invoices.profile(org.organizationId)) ?? {};
  }

  @Put()
  @RequirePermission('billing:write')
  @ApiZodBody(BillingProfileBody)
  @ApiZodOk(JsonObjectSchema)
  put(
    @Org() org: OrgContext,
    @Body(new ZodPipe(BillingProfileBody)) body: z.infer<typeof BillingProfileBody>,
  ) {
    return this.invoices.putProfile(org, body);
  }
}

/** Operator: every organization's invoices, the monthly run, the ledger check and profit. */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('orgs/:orgId/billing')
@UseGuards(AccessGuard, OrgGuard, PlatformGuard)
export class InvoicesAdminController {
  constructor(@Inject(InvoicesService) private readonly invoices: InvoicesService) {}

  @Get('invoices')
  @RequirePermission('billing:read')
  @ApiZodQuery(PeriodQuery)
  @ApiZodOk(JsonListSchema)
  list(@Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>) {
    return this.invoices.list(undefined, q.period);
  }

  @Post('invoices/generate')
  @HttpCode(200)
  @RequirePermission('billing:write')
  @ApiZodQuery(GenerateQuery)
  @ApiZodOk(JsonObjectSchema)
  generate(@Query(new ZodPipe(GenerateQuery)) q: z.infer<typeof GenerateQuery>) {
    return this.invoices.generate(q.period);
  }

  @Get('invoices/:id/verify')
  @RequirePermission('billing:read')
  @ApiZodOk(JsonObjectSchema)
  verify(@Param('id') id: string) {
    return this.invoices.verify(id);
  }

  @Get('invoices/:id/pdf')
  @RequirePermission('billing:read')
  @ApiProduces('application/pdf')
  @ApiZodOk(z.string(), 'PDF')
  async pdf(@Param('id') id: string, @Res() reply: FastifyReply) {
    await sendPdf(reply, await this.invoices.pdf(id));
  }

  @Get('reports/profit')
  @RequirePermission('billing:read')
  @ApiZodQuery(ProfitQuery)
  @ApiZodOk(JsonObjectSchema)
  profit(@Query(new ZodPipe(ProfitQuery)) q: z.infer<typeof ProfitQuery>) {
    return this.invoices.profit(q.from, q.to, {
      ...(q.organizationId ? { organizationId: q.organizationId } : {}),
      ...(q.model ? { model: q.model } : {}),
    });
  }
}
