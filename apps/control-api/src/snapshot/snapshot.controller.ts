import { timingSafeEqual } from 'node:crypto';

import { DiRouterError } from '@dirouter/shared';
import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { ENV, type Env } from '../env.js';
import { SnapshotService } from './snapshot.service.js';

/** endpoint داخلی گیت‌وی: فقط با INTERNAL_TOKEN، با ETag و 304 (کارت ۳.۹). */
@ApiExcludeController()
@Controller('internal/config')
export class SnapshotController {
  constructor(
    @Inject(SnapshotService) private readonly snapshots: SnapshotService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('snapshot')
  async snapshot(
    @Headers('authorization') authorization: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const expected = Buffer.from(`Bearer ${this.env.INTERNAL_TOKEN}`);
    const given = Buffer.from(authorization ?? '');
    // بدون توکن درست، مسیر وجود ندارد.
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new DiRouterError('not_found');
    const latest = await this.snapshots.latest();
    if (!latest) throw new DiRouterError('service_unavailable', { message: 'No snapshot yet' });
    const etag = `"v${String(latest.version)}-${latest.checksum.slice(0, 16)}"`;
    void reply.header('etag', etag).header('cache-control', 'no-cache');
    if (ifNoneMatch === etag) return reply.status(304).send();
    return reply.status(200).send(latest.snapshot);
  }
}
