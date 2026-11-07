import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service.js';
import { ValkeyService } from './valkey.service.js';

@Global()
@Module({
  providers: [PrismaService, ValkeyService],
  exports: [PrismaService, ValkeyService],
})
export class InfraModule {}
