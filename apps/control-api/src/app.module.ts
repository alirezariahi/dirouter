import { type DynamicModule, Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { ENV, type Env } from './env.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';
import { KeysModule } from './keys/keys.module.js';
import { OrgsModule } from './orgs/orgs.module.js';
import { ProvidersModule } from './providers/providers.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [InfraModule, AuthModule, OrgsModule, ProvidersModule, KeysModule],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
