import { timingSafeEqual } from 'node:crypto';

import { DiRouterError } from '@dirouter/shared';
import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  UseGuards,
  Body,
} from '@nestjs/common';
import { ApiExcludeController, ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { ENV, type Env } from '../env.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { can } from '../rbac/permissions.js';
import { SemanticCacheService } from './semantic-cache.service.js';

const QueryBody = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().max(200).optional(),
  embeddingModel: z.string().max(200).optional(),
  model: z.string().min(1).max(200),
  text: z.string().max(100_000),
  threshold: z.number().min(0).max(1).default(0.9),
});
const StoreBody = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().max(200).optional(),
  embeddingModel: z.string().max(200).optional(),
  modelId: z.string().min(1),
  model: z.string().min(1).max(200),
  text: z.string().max(100_000),
  response: z.unknown(),
  ttlSeconds: z.number().int().min(1).max(2_592_000).default(3600),
});
const SampleQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

@ApiExcludeController()
@Controller('internal/semantic-cache')
export class SemanticCacheInternalController {
  constructor(
    @Inject(SemanticCacheService) private readonly cache: SemanticCacheService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  #authorized(authorization: string | undefined): void {
    const expected = Buffer.from(`Bearer ${this.env.INTERNAL_TOKEN}`);
    const given = Buffer.from(authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new DiRouterError('not_found');
  }

  @Post('query')
  @HttpCode(200)
  @ApiZodBody(QueryBody)
  async query(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodPipe(QueryBody)) body: z.infer<typeof QueryBody>,
  ) {
    this.#authorized(authorization);
    return this.cache.query(body);
  }

  @Post('store')
  @HttpCode(204)
  async store(
    @Headers('authorization') authorization: string | undefined,
    @Body(new ZodPipe(StoreBody)) body: z.infer<typeof StoreBody>,
  ) {
    this.#authorized(authorization);
    await this.cache.store(body);
  }

  @Delete('expired')
  @HttpCode(200)
  async expired(@Headers('authorization') authorization: string | undefined) {
    this.#authorized(authorization);
    return { deleted: await this.cache.purgeExpired() };
  }
}

@ApiTags('cache')
@ApiBearerAuth()
@Controller('orgs/:orgId/cache/semantic')
@UseGuards(AccessGuard, OrgGuard)
export class SemanticCacheController {
  constructor(@Inject(SemanticCacheService) private readonly cache: SemanticCacheService) {}

  @Get()
  @RequirePermission('models:read')
  @ApiZodOk(JsonObjectSchema)
  async info(
    @Org() org: OrgContext,
    @Query(new ZodPipe(SampleQuery)) q: z.infer<typeof SampleQuery>,
  ) {
    // The sample shows excerpts of prompts sent by other users, so the counters are open to
    // `models:read` but the excerpts only to roles that may also purge the cache (`models:write`).
    const sampleAllowed = can(org.role, 'models:write');
    const [stats, sample] = await Promise.all([
      this.cache.stats(org),
      sampleAllowed ? this.cache.sample(org, q.limit) : Promise.resolve([]),
    ]);
    return { ...stats, sample, sampleAllowed };
  }

  @Delete()
  @HttpCode(200)
  @RequirePermission('models:write')
  @ApiZodOk(JsonObjectSchema)
  async purge(@Org() org: OrgContext) {
    return { deleted: await this.cache.purgeOrg(org) };
  }
}
