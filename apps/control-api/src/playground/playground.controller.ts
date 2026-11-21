import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { PlaygroundBody, PlaygroundResponse } from './playground.schema.js';
import { PlaygroundService } from './playground.service.js';

@ApiTags('playground')
@ApiBearerAuth()
@Controller('orgs/:orgId/playground')
@UseGuards(AccessGuard, OrgGuard)
export class PlaygroundController {
  constructor(@Inject(PlaygroundService) private readonly service: PlaygroundService) {}

  /** Runs one prompt against up to four models; usage is billed to the supplied key. */
  @Post('compare')
  @HttpCode(200)
  @RequirePermission('models:read')
  @ApiZodBody(PlaygroundBody)
  @ApiZodOk(PlaygroundResponse)
  compare(
    @Org() org: OrgContext,
    @Body(new ZodPipe(PlaygroundBody)) body: z.infer<typeof PlaygroundBody>,
  ) {
    return this.service.compare(org, body);
  }
}
