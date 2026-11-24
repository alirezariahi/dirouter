import { Global, Module } from '@nestjs/common';

import { MailService } from './mail.service.js';
import { PrismaService } from './prisma.service.js';
import { ValkeyService } from './valkey.service.js';

@Global()
@Module({
  providers: [PrismaService, ValkeyService, MailService],
  exports: [PrismaService, ValkeyService, MailService],
})
export class InfraModule {}
