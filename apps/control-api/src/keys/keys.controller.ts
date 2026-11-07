import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { ApiZodBody, ApiZodOk, ApiZodQuery, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { KeysService } from './keys.service.js';

const Budget = z.object({
  period: z.enum(['daily', 'monthly']),
  limitUsd: z
    .string()
    .regex(/^\d{1,10}(\.\d{1,8})?$/)
    .optional(),
  limitTokens: z.int().positive().optional(),
  alertThresholds: z.array(z.int().min(1).max(100)).max(10).optional(),
});
export const KeyBody = z.object({
  name: z.string().trim().min(1).max(100),
  projectId: z.string().min(1),
  allowedModels: z.array(z.string().min(1).max(128)).max(200).optional(),
  ipAllowlist: z.array(z.string().max(64)).max(100).optional(),
  rpm: z.int().positive().nullable().optional(),
  tpm: z.int().positive().nullable().optional(),
  maxConcurrency: z.int().positive().nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  budgets: z.array(Budget).max(2).optional(),
});
export const KeyPatch = KeyBody.omit({ projectId: true }).partial();
export const RotateBody = z.object({
  graceSeconds: z
    .int()
    .min(0)
    .max(30 * 24 * 3600)
    .default(24 * 3600),
});
const ListQuery = z.object({ projectId: z.string().optional() });

const KeyView = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  projectId: z.string(),
  state: z.enum(['active', 'rotating', 'expired', 'revoked']),
  allowedModels: z.array(z.string()),
  ipAllowlist: z.array(z.string()),
  rpm: z.int().nullable(),
  tpm: z.int().nullable(),
  maxConcurrency: z.int().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  rotatedToId: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  budgets: z.array(
    z.object({
      id: z.string(),
      period: z.enum(['daily', 'monthly']),
      limitUsd: z.string().nullable(),
      limitTokens: z.int().nullable(),
      alertThresholds: z.array(z.int()),
    }),
  ),
});
const WithSecret = KeyView.extend({ key: z.string().describe('کلید کامل؛ فقط همین یک بار') });

@ApiTags('virtual keys')
@ApiBearerAuth()
@Controller('orgs/:orgId/keys')
@UseGuards(AccessGuard, OrgGuard)
export class KeysController {
  constructor(@Inject(KeysService) private readonly keys: KeysService) {}

  @Get()
  @RequirePermission('keys:read')
  @ApiZodQuery(ListQuery)
  @ApiZodOk(z.array(KeyView))
  list(@Org() org: OrgContext, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.keys.list(org, q.projectId);
  }

  @Post()
  @RequirePermission('keys:write')
  @ApiZodBody(KeyBody)
  @ApiZodOk(WithSecret, 'کلید کامل فقط در همین پاسخ می‌آید')
  create(@Org() org: OrgContext, @Body(new ZodPipe(KeyBody)) body: z.infer<typeof KeyBody>) {
    return this.keys.create(org, body);
  }

  @Get(':id')
  @RequirePermission('keys:read')
  @ApiZodOk(KeyView)
  get(@Org() org: OrgContext, @Param('id') id: string) {
    return this.keys.get(org, id);
  }

  @Patch(':id')
  @RequirePermission('keys:write')
  @ApiZodBody(KeyPatch)
  @ApiZodOk(KeyView)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(KeyPatch)) body: z.infer<typeof KeyPatch>,
  ) {
    return this.keys.update(org, id, body);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('keys:write')
  @ApiZodOk(KeyView)
  revoke(@Org() org: OrgContext, @Param('id') id: string) {
    return this.keys.revoke(org, id);
  }

  @Post(':id/rotate')
  @RequirePermission('keys:write')
  @ApiZodBody(RotateBody)
  @ApiZodOk(WithSecret.extend({ previous: KeyView }), 'کلید قدیم تا پایان مهلت معتبر می‌ماند')
  rotate(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(RotateBody)) body: z.infer<typeof RotateBody>,
  ) {
    return this.keys.rotate(org, id, body.graceSeconds);
  }
}
