import { Global, Module } from '@nestjs/common';

import { SnapshotController } from './snapshot.controller.js';
import { SnapshotService } from './snapshot.service.js';

@Global()
@Module({
  controllers: [SnapshotController],
  providers: [SnapshotService],
  exports: [SnapshotService],
})
export class SnapshotModule {}
