import { type DynamicModule, Module } from '@nestjs/common';

import { ENV, type Env } from './env.js';
import { HealthController } from './health/health.controller.js';
import { InfraModule } from './infra/infra.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [InfraModule],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }],
      exports: [ENV],
    };
  }
}
