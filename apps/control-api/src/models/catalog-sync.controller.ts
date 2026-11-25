/**
 * Catalog sync administration (card 27.5): settings, runs, and price proposals. The catalog is
 * shared by every organization, so only the platform organization's operators reach these routes.
 */
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { PlatformGuard } from '../billing/platform.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { CatalogService } from './catalog.service.js';

export const CatalogSyncSettingsBody = z.object({
  /** Switch the external sources off; the catalog keeps what was last synced. */
  enabled: z.boolean().optional(),
  /** Up to five URLs (an internal mirror replaces the public list); empty = environment default. */
  sources: z
    .array(z.url({ protocol: /^https?$/ }).max(2048))
    .max(5)
    .optional(),
  /** `manual`: every price change waits for approval; `auto`: applied unless above the factor. */
  mode: z.enum(['manual', 'auto']).optional(),
  maxChangeFactor: z.number().min(1).max(1000).optional(),
});
const ProposalStatus = z.enum(['pending', 'approved', 'rejected', 'superseded']);

const SyncRun = z.object({
  id: z.string(),
  status: z.string(),
  sources: z.array(z.string()),
  mode: z.string(),
  added: z.int(),
  updated: z.int(),
  repriced: z.int(),
  proposed: z.int(),
  removed: z.int(),
  skipped: z.int(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
const SyncStatus = z.object({
  settings: CatalogSyncSettingsBody,
  pendingProposals: z.int(),
  runs: z.array(SyncRun),
});
const Proposal = z.object({
  id: z.string(),
  catalogKey: z.string(),
  source: z.string(),
  currentPricing: z.unknown(),
  proposedPricing: z.unknown(),
  changeFactor: z.string().nullable(),
  reason: z.string(),
  status: ProposalStatus,
  decidedById: z.string().nullable(),
  decidedAt: z.string().nullable(),
  appliedModels: z.int().nullable(),
  createdAt: z.string(),
});

@ApiTags('models')
@ApiBearerAuth()
@Controller('orgs/:orgId/catalog-sync')
@UseGuards(AccessGuard, OrgGuard, PlatformGuard)
export class CatalogSyncController {
  constructor(@Inject(CatalogService) private readonly catalogs: CatalogService) {}

  @Get()
  @RequirePermission('models:read')
  @ApiZodOk(SyncStatus, 'تنظیمات، آخرین اجراها و تعداد پیشنهادهای در انتظار')
  status() {
    return this.catalogs.status();
  }

  @Put('settings')
  @RequirePermission('models:write')
  @ApiZodBody(CatalogSyncSettingsBody)
  @ApiZodOk(CatalogSyncSettingsBody)
  settings(
    @Org() org: OrgContext,
    @Body(new ZodPipe(CatalogSyncSettingsBody)) body: z.infer<typeof CatalogSyncSettingsBody>,
  ) {
    return this.catalogs.updateSettings(org, body);
  }

  @Post('run')
  @HttpCode(202)
  @RequirePermission('models:write')
  @ApiZodOk(z.object({ queued: z.boolean(), jobId: z.string().nullable() }))
  run(@Org() org: OrgContext) {
    return this.catalogs.runNow(org);
  }

  @Get('proposals')
  @RequirePermission('models:read')
  @ApiZodOk(z.array(Proposal))
  proposals(
    @Query('status', new ZodPipe(ProposalStatus.optional()))
    status?: z.infer<typeof ProposalStatus>,
  ) {
    return this.catalogs.proposals(status);
  }

  @Post('proposals/:id/approve')
  @HttpCode(200)
  @RequirePermission('models:write')
  @ApiZodOk(
    z.object({
      id: z.string(),
      status: z.literal('approved'),
      catalogKey: z.string(),
      appliedModels: z.int(),
    }),
  )
  approve(@Org() org: OrgContext, @Param('id') id: string) {
    return this.catalogs.approve(org, id);
  }

  @Post('proposals/:id/reject')
  @HttpCode(200)
  @RequirePermission('models:write')
  @ApiZodOk(z.object({ id: z.string(), status: z.literal('rejected') }))
  reject(@Org() org: OrgContext, @Param('id') id: string) {
    return this.catalogs.reject(org, id);
  }
}
