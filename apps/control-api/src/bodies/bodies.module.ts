import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { BodiesController } from './bodies.controller.js';
import { BodiesService } from './bodies.service.js';

/** Request body capture levels and stored payloads (card 24.1). */
@Module({
  controllers: [BodiesController],
  providers: [BodiesService, OrgGuard],
})
export class BodiesModule {}
