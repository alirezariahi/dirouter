import { PassThrough } from 'node:stream';

import { Body, Controller, HttpCode, Inject, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { AccessGuard } from '../auth/auth.guard.js';
import { ApiZodBody, ApiZodOk, ZodPipe } from '../common/zod.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { PlaygroundBody, PlaygroundResponse, PlaygroundStreamBody } from './playground.schema.js';
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

  /**
   * One model, streamed (card 25.6): `text/event-stream` with `meta`, `ttft`, `chunk`, `error` and
   * `end` events. Closing the connection cancels the gateway request.
   */
  @Post('stream')
  @HttpCode(200)
  @RequirePermission('models:read')
  @ApiZodBody(PlaygroundStreamBody)
  @ApiZodOk(z.string(), 'text/event-stream: meta, ttft, chunk, error and end events')
  async stream(
    @Org() org: OrgContext,
    @Body(new ZodPipe(PlaygroundStreamBody)) body: z.infer<typeof PlaygroundStreamBody>,
    @Res() reply: FastifyReply,
  ) {
    const abort = new AbortController();
    const { events } = await this.service.prepareStream(org, body, abort.signal);
    const out = new PassThrough();
    reply.raw.on('close', () => {
      abort.abort();
    });
    void (async () => {
      try {
        for await (const event of events) out.write(event);
      } finally {
        out.end();
      }
    })();
    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no')
      .send(out);
  }
}
