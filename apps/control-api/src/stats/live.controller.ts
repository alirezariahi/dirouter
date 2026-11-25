import { DiRouterError } from '@dirouter/shared';
import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AccessGuard } from '../auth/auth.guard.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { LiveHub } from './live.hub.js';

/** Keeps proxies from closing an idle stream; SSE comments are ignored by clients. */
export const LIVE_HEARTBEAT_MS = 15_000;

@ApiTags('stats & logs')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class LiveController {
  constructor(@Inject(LiveHub) private readonly hub: LiveHub) {}

  /**
   * Live view over Server-Sent Events (card 24.4): `event: request` with one request's metadata
   * as soon as the gateway finishes it. The page falls back to polling `stats/live` when the
   * stream drops. Authenticated with the bearer token like any route (read it with fetch).
   */
  @Get('stats/live/stream')
  @RequirePermission('usage:read')
  @ApiOkResponse({
    description: 'text/event-stream: `ready`, then one `request` event per finished request',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  async stream(@Org() org: OrgContext, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const raw = reply.raw;
    let beat: NodeJS.Timeout | undefined;
    const write = (chunk: string) => {
      if (!raw.destroyed && !raw.writableEnded) raw.write(chunk);
    };
    const subscription = this.hub.subscribe(org.organizationId, (event) => {
      write(`event: request\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    if (!subscription)
      throw new DiRouterError('service_unavailable', {
        message: 'Too many live streams; poll stats/live instead',
      });
    reply.hijack();
    // CORS and request-id headers were set on the reply before the handler; keep them.
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined)
        headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    const close = () => {
      if (beat) clearInterval(beat);
      beat = undefined;
      subscription.off();
      if (!raw.writableEnded) raw.end();
    };
    req.raw.once('close', close);
    raw.once('close', close);
    // `ready` only once the subscription is live: an event published after it is never missed.
    write('retry: 3000\n\n');
    await Promise.race([subscription.ready, new Promise((r) => setTimeout(r, 2_000))]);
    write('event: ready\ndata: {}\n\n');
    beat = setInterval(() => {
      write(': keep-alive\n\n');
    }, LIVE_HEARTBEAT_MS);
    beat.unref();
    if (raw.destroyed) close();
  }
}
