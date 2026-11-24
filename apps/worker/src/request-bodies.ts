/**
 * Request bodies (card 24.1): records from the gateway's `request-bodies` queue become rows of
 * the daily-partitioned `request_bodies` table (idempotent by request id and time). Partitions are
 * created ahead and dropped after REQUEST_BODY_RETENTION_DAYS, apart from request_log's monthly
 * partitions and their own retention.
 */
import { RequestBodyRecord } from '@dirouter/contracts';
import { Prisma } from '@dirouter/db';

import type { MaintenanceDb } from './maintenance.js';

export interface BodyDb {
  requestBody: {
    createMany(args: {
      data: Prisma.RequestBodyCreateManyInput[];
      skipDuplicates: boolean;
    }): Promise<{ count: number }>;
  };
}

/** Throws a ZodError for a record that does not parse (not worth retrying). */
export async function writeRequestBody(db: BodyDb, data: unknown): Promise<boolean> {
  const body = RequestBodyRecord.parse(data);
  const { count } = await db.requestBody.createMany({
    data: [
      {
        requestId: body.requestId,
        createdAt: new Date(body.createdAt),
        organizationId: body.organizationId,
        projectId: body.projectId,
        apiKeyId: body.apiKeyId,
        inboundApi: body.inboundApi,
        level: body.level,
        metadata: body.metadata,
        request: body.request ?? null,
        requestTruncated: body.requestTruncated,
        response: body.response ?? null,
        responseTruncated: body.responseTruncated,
        streamed: body.streamed,
        redactions: body.redactions,
        replay: body.replay ?? Prisma.DbNull,
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}

const BODY_PARTITION_LOCK = 482_902; // fixed advisory lock key, next to request_log's

export async function ensureBodyPartitions(db: MaintenanceDb, daysAhead = 3): Promise<number> {
  const [, rows] = await db.$transaction([
    db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock($1)', BODY_PARTITION_LOCK),
    db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT dirouter_ensure_request_body_partitions($1)::int AS n',
      daysAhead,
    ),
  ]);
  return rows[0]?.n ?? 0;
}

export async function dropOldBodyPartitions(
  db: MaintenanceDb,
  retainDays: number,
): Promise<number> {
  const [, rows] = await db.$transaction([
    db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock($1)', BODY_PARTITION_LOCK),
    db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT dirouter_drop_request_body_partitions($1)::int AS n',
      retainDays,
    ),
  ]);
  return rows[0]?.n ?? 0;
}
