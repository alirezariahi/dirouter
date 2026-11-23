import { Module } from '@nestjs/common';

import { BillingModule } from '../billing/billing.module.js';
import { KeysModule } from '../keys/keys.module.js';
import { SnapshotModule } from '../snapshot/snapshot.module.js';
import { StatsModule } from '../stats/stats.module.js';
import { AdminMcpController } from './admin-mcp.controller.js';
import { AdminMcpService } from './admin-mcp.service.js';

@Module({
  imports: [KeysModule, StatsModule, BillingModule, SnapshotModule],
  controllers: [AdminMcpController],
  providers: [AdminMcpService],
})
export class AdminMcpModule {}
