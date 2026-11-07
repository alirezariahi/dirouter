import type { Logger } from '@dirouter/shared';
import { type DynamicModule, Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { ENV, type Env } from './env.js';
import { LOGGER } from './infra/tokens.js';
import { SnapshotModule } from './snapshot/snapshot.module.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { KeysModule } from './keys/keys.module.js';
import { ModelsModule } from './models/models.module.js';
import { OrgsModule } from './orgs/orgs.module.js';
import { ProvidersModule } from './providers/providers.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        InfraModule,
        AuthModule,
        OrgsModule,
        ProvidersModule,
        KeysModule,
        ModelsModule,
        SnapshotModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: LOGGER, useValue: logger },
      ],
      exports: [ENV, LOGGER],
    };
  }
}
