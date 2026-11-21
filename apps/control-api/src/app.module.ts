import type { Logger } from '@dirouter/shared';
import { type DynamicModule, Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { ConfigModule } from './config/config.module.js';
import { ENV, type Env } from './env.js';
import { GuardrailsModule } from './guardrails/guardrails.module.js';
import { LOGGER } from './infra/tokens.js';
import { SnapshotModule } from './snapshot/snapshot.module.js';
import { StatsModule } from './stats/stats.module.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { KeysModule } from './keys/keys.module.js';
import { ModelsModule } from './models/models.module.js';
import { OrgsModule } from './orgs/orgs.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { SecurityModule } from './security/security.module.js';
import { SemanticCacheModule } from './semantic-cache/semantic-cache.module.js';
import { PlaygroundModule } from './playground/playground.module.js';

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
        StatsModule,
        GuardrailsModule,
        AlertsModule,
        ConfigModule,
        SecurityModule,
        SemanticCacheModule,
        PlaygroundModule,
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
