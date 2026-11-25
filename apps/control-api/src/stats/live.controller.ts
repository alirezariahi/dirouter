import { DiRouterError, RateLimitError } from '@dirouter/shared';
import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AccessGuard } from '../auth/auth.guard.js';
import type { AccessClaims } from '../auth/crypto.js';
import { SessionsService } from '../auth/sessions.service.js';
import { PrismaService } from '../infra/prisma.service.js';
import { Org, OrgGuard, type OrgContext, RequirePermission } from '../rbac/org.guard.js';
import { canAny } from '../rbac/permissions.js';
import { LiveHub, MAX_LIVE_STREAMS_PER_USER } from './live.hub.js';

/** Keeps proxies from closing an idle stream; SSE comments are ignored by clients. */
export const LIVE_HEARTBEAT_MS = 15_000;

/**
 * How often an open stream re-checks that its caller may still read it (session not signed out,
 * still a member with usage:read, management token not revoked). Mutable for tests only.
 */
export const liveTimings = { recheckMs: 30_000 };

@ApiTags('stats & logs')
@ApiBearerAuth()
@Controller('orgs/:orgId')
@UseGuards(AccessGuard, OrgGuard)
export class LiveController {
  constructor(
    @Inject(LiveHub) private readonly hub: LiveHub,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * The guards ran once, when the stream opened; a stream can stay open for hours. This repeats
   * what they checked that can change: the session or management token is still valid, and the
   * caller is still a member of the organization whose role grants usage:read.
   */
  async #stillAllowed(user: AccessClaims, organizationId: string): Promise<boolean> {
    const db = this.prisma.client;
    if (user.token) {
      const token = await db.managementToken.findUnique({
        where: { id: user.token.id },
        select: {
          revokedAt: true,
          expiresAt: true,
          scopes: true,
          serviceAccount: { select: { deletedAt: true } },
        },
      });
      if (
        !token ||
        token.revokedAt ||
        (token.expiresAt && token.expiresAt.getTime() <= Date.now()) ||
        token.serviceAccount.deletedAt ||
        !token.scopes.includes('usage:read')
      )
        return false;
    } else if (user.sid && !(await this.sessions.isActive(user.sid))) return false;
    const account = await db.user.findUnique({
      where: { id: user.sub },
      select: { isActive: true, deletedAt: true },
    });
    if (!account?.isActive || account.deletedAt) return false;
    const membership = await db.membership.findUnique({
      where: { userId_organizationId: { userId: user.sub, organizationId } },
      select: {
        role: true,
        organization: { select: { deletedAt: true } },
        customRole: { select: { permissions: true } },
      },
    });
    return (
      membership !== null &&
      !membership.organization.deletedAt &&
      canAny(membership.role, membership.customRole?.permissions, 'usage:read')
    );
  }

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
  async stream(
    @Org() org: OrgContext,
    @Req() req: FastifyRequest & { user?: AccessClaims },
    @Res() reply: FastifyReply,
  ) {
    const raw = reply.raw;
    const user = req.user;
    if (!user) throw new DiRouterError('not_found');
    let beat: NodeJS.Timeout | undefined;
    let recheck: NodeJS.Timeout | undefined;
    const write = (chunk: string) => {
      if (!raw.destroyed && !raw.writableEnded) raw.write(chunk);
    };
    const subscription = this.hub.subscribe(
      org.organizationId,
      (event) => {
        write(`event: request\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      },
      user.sub,
    );
    if (subscription === 'full')
      throw new DiRouterError('service_unavailable', {
        message: 'Too many live streams; poll stats/live instead',
      });
    if (subscription === 'user')
      throw new RateLimitError({
        message: `At most ${String(MAX_LIVE_STREAMS_PER_USER)} live streams at once; close one or poll stats/live`,
        retryAfterMs: LIVE_HEARTBEAT_MS,
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
      if (recheck) clearInterval(recheck);
      beat = undefined;
      recheck = undefined;
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
    let checking = false;
    recheck = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.#stillAllowed(user, org.organizationId)
        // A failed check (database unreachable) closes the stream too: the page falls back to
        // polling, which goes through the guards again.
        .catch(() => false)
        .then((allowed) => {
          checking = false;
          if (allowed) return;
          write('event: revoked\ndata: {}\n\n');
          close();
        });
    }, liveTimings.recheckMs);
    recheck.unref();
    if (raw.destroyed) close();
  }
}
