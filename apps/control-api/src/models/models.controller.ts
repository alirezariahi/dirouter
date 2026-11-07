import { UpstreamErrorClass } from '@dirouter/contracts';
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { ModelsService } from './models.service.js';

const Usd = z.string().regex(/^\d{1,10}(\.\d{1,8})?$/);
const Name = z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/i, 'letters, digits, . _ / -');
const Pricing = z.object({
  inputPerMTok: Usd,
  outputPerMTok: Usd,
  cacheReadPerMTok: Usd.optional(),
  cacheWritePerMTok: Usd.optional(),
  reasoningPerMTok: Usd.optional(),
});
const Capabilities = z.object({
  streaming: z.boolean().optional(),
  tools: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  jsonMode: z.boolean().optional(),
});
export const ModelBody = z.object({
  providerId: z.string(),
  upstreamModel: z.string().min(1).max(200),
  slug: Name.optional(),
  displayName: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  contextWindow: z.int().positive().nullable().optional(),
  maxOutputTokens: z.int().positive().nullable().optional(),
  pricing: Pricing.partial().optional(),
  capabilities: Capabilities.optional(),
  catalogKey: z.string().max(200).nullable().optional(),
});
export const ModelPatch = ModelBody.omit({ providerId: true, upstreamModel: true }).partial();
export const AliasBody = z.object({
  slug: Name,
  modelId: z.string().optional(),
  comboId: z.string().optional(),
});
export const AliasPatch = AliasBody.partial();
export const ComboBody = z.object({
  slug: Name,
  strategy: z.enum(['priority', 'weighted', 'round-robin']).optional(),
  targets: z
    .array(
      z.object({
        modelId: z.string(),
        order: z.int().min(0).optional(),
        weight: z.int().min(0).max(1000).optional(),
      }),
    )
    .min(1)
    .max(20),
  fallbackOn: z.array(UpstreamErrorClass).optional(),
  retryMaxAttempts: z.int().min(1).max(10).optional(),
  timeouts: z
    .object({
      connectMs: z.int().positive().optional(),
      firstByteMs: z.int().positive().optional(),
      idleMs: z.int().positive().optional(),
      totalMs: z.int().positive().optional(),
    })
    .nullable()
    .optional(),
});
export const ComboPatch = ComboBody.partial();

const ModelView = z.object({
  id: z.string(),
  slug: z.string(),
  providerId: z.string(),
  upstreamModel: z.string(),
  displayName: z.string().nullable(),
  enabled: z.boolean(),
  contextWindow: z.int().nullable(),
  maxOutputTokens: z.int().nullable(),
  pricing: Pricing,
  capabilities: z.unknown(),
  catalogKey: z.string().nullable(),
});
const AliasView = z.object({
  id: z.string(),
  slug: z.string(),
  target: z.union([
    z.object({ kind: z.literal('model'), modelId: z.string() }),
    z.object({ kind: z.literal('combo'), comboId: z.string() }),
  ]),
});
const ComboView = z.object({
  id: z.string(),
  slug: z.string(),
  strategy: z.enum(['priority', 'weighted', 'round-robin']),
  targets: z.array(z.object({ modelId: z.string(), order: z.int(), weight: z.int() })),
  fallbackOn: z.array(z.string()),
  retryMaxAttempts: z.int(),
  timeouts: z.unknown(),
});

@ApiTags('models')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class ModelsController {
  constructor(@Inject(ModelsService) private readonly models: ModelsService) {}

  @Get('catalog')
  @RequirePermission('models:read')
  @ApiZodOk(
    z.object({ version: z.string(), currency: z.string(), models: z.array(z.unknown()) }),
    'کاتالوگ نسخه‌دار قیمت',
  )
  catalog() {
    return this.models.catalog();
  }

  @Get('models')
  @RequirePermission('models:read')
  @ApiZodOk(z.array(ModelView))
  list(@Org() org: OrgContext) {
    return this.models.models(org);
  }

  @Post('models')
  @RequirePermission('models:write')
  @ApiZodBody(ModelBody)
  @ApiZodOk(ModelView, 'با catalogKey قیمت، context و قابلیت از کاتالوگ پر می‌شود')
  create(@Org() org: OrgContext, @Body(new ZodPipe(ModelBody)) body: z.infer<typeof ModelBody>) {
    return this.models.createModel(org, body);
  }

  @Post('models/sync-catalog')
  @HttpCode(200)
  @RequirePermission('models:write')
  @ApiZodOk(z.object({ catalogVersion: z.string(), updated: z.int() }))
  sync(@Org() org: OrgContext) {
    return this.models.syncCatalog(org);
  }

  @Get('models/:id')
  @RequirePermission('models:read')
  @ApiZodOk(ModelView)
  async get(@Org() org: OrgContext, @Param('id') id: string) {
    return this.models.modelView(await this.models.loadModel(org, id));
  }

  @Patch('models/:id')
  @RequirePermission('models:write')
  @ApiZodBody(ModelPatch)
  @ApiZodOk(ModelView)
  update(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ModelPatch)) body: z.infer<typeof ModelPatch>,
  ) {
    return this.models.updateModel(org, id, body);
  }

  @Delete('models/:id')
  @HttpCode(204)
  @RequirePermission('models:write')
  @ApiNoContentResponse()
  async remove(@Org() org: OrgContext, @Param('id') id: string) {
    await this.models.deleteModel(org, id);
  }

  @Get('aliases')
  @RequirePermission('models:read')
  @ApiZodOk(z.array(AliasView))
  aliases(@Org() org: OrgContext) {
    return this.models.aliases(org);
  }

  @Post('aliases')
  @RequirePermission('models:write')
  @ApiZodBody(AliasBody)
  @ApiZodOk(AliasView)
  createAlias(
    @Org() org: OrgContext,
    @Body(new ZodPipe(AliasBody)) body: z.infer<typeof AliasBody>,
  ) {
    return this.models.createAlias(org, body);
  }

  @Patch('aliases/:id')
  @RequirePermission('models:write')
  @ApiZodBody(AliasPatch)
  @ApiZodOk(AliasView)
  updateAlias(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(AliasPatch)) body: z.infer<typeof AliasPatch>,
  ) {
    return this.models.updateAlias(org, id, body);
  }

  @Delete('aliases/:id')
  @HttpCode(204)
  @RequirePermission('models:write')
  @ApiNoContentResponse()
  async deleteAlias(@Org() org: OrgContext, @Param('id') id: string) {
    await this.models.deleteAlias(org, id);
  }

  @Get('combos')
  @RequirePermission('models:read')
  @ApiZodOk(z.array(ComboView))
  combos(@Org() org: OrgContext) {
    return this.models.combos(org);
  }

  @Post('combos')
  @RequirePermission('models:write')
  @ApiZodBody(ComboBody)
  @ApiZodOk(ComboView)
  createCombo(
    @Org() org: OrgContext,
    @Body(new ZodPipe(ComboBody)) body: z.infer<typeof ComboBody>,
  ) {
    return this.models.createCombo(org, body);
  }

  @Get('combos/:id')
  @RequirePermission('models:read')
  @ApiZodOk(ComboView)
  async getCombo(@Org() org: OrgContext, @Param('id') id: string) {
    return this.models.comboView(await this.models.loadCombo(org, id));
  }

  @Patch('combos/:id')
  @RequirePermission('models:write')
  @ApiZodBody(ComboPatch)
  @ApiZodOk(ComboView)
  updateCombo(
    @Org() org: OrgContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ComboPatch)) body: z.infer<typeof ComboPatch>,
  ) {
    return this.models.updateCombo(org, id, body);
  }

  @Delete('combos/:id')
  @HttpCode(204)
  @RequirePermission('models:write')
  @ApiNoContentResponse()
  async deleteCombo(@Org() org: OrgContext, @Param('id') id: string) {
    await this.models.deleteCombo(org, id);
  }
}
