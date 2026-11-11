import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';

type Check = { status: 'ok' } | { status: 'error'; error: string };

async function check(fn: () => Promise<unknown>, timeoutMs = 2_000): Promise<Check> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => {
          reject(new Error('timeout'));
        }, timeoutMs),
      ),
    ]);
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', error: (error as Error).message };
  }
}

@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  /** liveness: only checks that the process is alive. */
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }

  /** readiness: Postgres and Valkey status. */
  @Get('readyz')
  async readyz(@Res() reply: FastifyReply) {
    const [database, valkey] = await Promise.all([
      check(() => this.prisma.ping()),
      check(() => this.valkey.ping()),
    ]);
    const ok = database.status === 'ok' && valkey.status === 'ok';
    return reply
      .status(ok ? 200 : 503)
      .send({ status: ok ? 'ok' : 'error', checks: { database, valkey } });
  }
}
