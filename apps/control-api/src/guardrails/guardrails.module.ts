import { Module } from '@nestjs/common';

import { OrgGuard } from '../rbac/org.guard.js';
import { GuardrailsController } from './guardrails.controller.js';
import { GuardrailsService } from './guardrails.service.js';

@Module({
  controllers: [GuardrailsController],
  providers: [GuardrailsService, OrgGuard],
  exports: [GuardrailsService],
})
export class GuardrailsModule {}
