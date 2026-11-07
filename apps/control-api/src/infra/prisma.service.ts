import { createPrismaClient, type PrismaClient } from '@dirouter/db';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';

import { ENV, type Env } from '../env.js';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
