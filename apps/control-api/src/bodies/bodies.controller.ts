import { Body, Controller, Get, Inject, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { BodiesService, CaptureLevelBody } from './bodies.service.js';

const Levels = z.object({
  defaultLevel: z.string().describe('instance default for keys without a level (OWNER setting)'),
  maxBytes: z.int().describe('size cap of each stored part, in bytes'),
  rules: z.array(
    z.object({
      scope: z.string(),
      scopeId: z.string(),
      level: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
const LevelSet = CaptureLevelBody.extend({ configVersion: z.int() });
const StoredBody = z.object({
  requestId: z.string(),
  createdAt: z.string(),
  inboundApi: z.string(),
  level: z.enum(['metadata', 'full']),
  metadata: z.record(z.string(), z.unknown()),
  request: z.string().nullable().describe('redacted request JSON as the client sent it'),
  requestTruncated: z.boolean(),
  response: z.string().nullable().describe('redacted answer; a stream is rebuilt as one answer'),
  responseTruncated: z.boolean(),
  streamed: z.boolean(),
  redactions: z.int(),
  replay: z
    .object({
      system: z.string().optional(),
      history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
      prompt: z.string(),
      maxTokens: z.int().optional(),
      temperature: z.number().optional(),
      lossy: z.boolean(),
    })
    .nullable()
    .describe('the conversation as the playground can send it again'),
});

@ApiTags('stats & logs')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class BodiesController {
  constructor(@Inject(BodiesService) private readonly service: BodiesService) {}

  /** Request body capture levels (card 24.1). */
  @Get('body-capture')
  @RequirePermission('logs:bodies')
  @ApiZodOk(Levels)
  levels(@Org() org: OrgContext) {
    return this.service.levels(org);
  }

  @Put('body-capture')
  @RequirePermission('logs:bodies')
  @ApiZodBody(CaptureLevelBody)
  @ApiZodOk(LevelSet, 'the level applies once the gateway loads the new snapshot')
  setLevel(
    @Org() org: OrgContext,
    @Body(new ZodPipe(CaptureLevelBody)) body: z.infer<typeof CaptureLevelBody>,
  ) {
    return this.service.setLevel(org, body);
  }

  /** The stored payload of one request (card 24.1); 404 when nothing was captured. */
  @Get('logs/:id/body')
  @RequirePermission('logs:bodies')
  @ApiZodOk(StoredBody)
  body(@Org() org: OrgContext, @Param('id') id: string) {
    return this.service.body(org, id);
  }
}
