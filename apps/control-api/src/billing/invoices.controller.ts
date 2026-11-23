import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodOk, ApiZodQuery, JsonListSchema, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { invoiceView, InvoicesService } from './invoices.service.js';
import { PlatformGuard } from './platform.guard.js';

const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
const Day = z.iso.date();
const PeriodQuery = z.object({ period: Period.optional() });
const GenerateQuery = z.object({ period: Period });
const ProfitQuery = z.object({ from: Day, to: Day });

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
    return this.invoices.profit(q.from, q.to);
  }
}
