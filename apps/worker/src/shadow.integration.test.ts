/** Shadow copies on real Postgres (card 32.4): their own table, nothing in usage or billing. */
import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { createPrismaClient } from '@dirouter/db';
import { afterAll, describe, expect, it } from 'vitest';

import { type ShadowDb, writeShadow } from './shadow.js';

const DATABASE_URL = process.env.INTEGRATION_DATABASE_URL;
const RUN = Date.now().toString(36);

describe.skipIf(!DATABASE_URL)('shadow copies in Postgres', () => {
  const db = createPrismaClient({ databaseUrl: DATABASE_URL ?? '', maxConnections: 2 });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('are written once to shadow_requests and never to the request log or the ledger', async () => {
    const id = `req_${RUN}:shadow`;
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: '01JABCDEFGHJKMNPQRSTVW0009',
      idempotencyKey: `${id}:shd_it`,
      requestId: id,
      occurredAt: new Date().toISOString(),
      gatewayInstance: 'gw',
      configVersion: 1,
      organizationId: 'org_shadow_it',
      teamId: null,
      projectId: 'prj',
      virtualKeyId: 'vk',
      inboundApi: 'openai.chat',
      requestedModel: 'next',
      resolvedModelId: 'mdl_next',
      providerId: 'p',
      credentialId: 'c',
      stream: false,
      status: 'success',
      httpStatus: 200,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: '0.50000000',
      chargeUsd: '0.00000000',
      usageEstimated: false,
      latencyMs: 10,
      attempts: [],
      shadow: {
        policyId: 'shd_it',
        primaryRequestId: `req_${RUN}`,
        primaryModel: 'big',
        primaryStatus: 200,
        primaryLatencyMs: 5,
        primaryCostUsd: '0.10000000',
      },
    };
    const shadowDb = db as unknown as ShadowDb;
    expect(await writeShadow(shadowDb, event)).toBe(true);
    expect(await writeShadow(shadowDb, event)).toBe(true);
    const rows = await db.shadowRequest.findMany({ where: { id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd.toString()).toBe('0.5');
    expect(await db.requestLog.count({ where: { id } })).toBe(0);
    expect(await db.usageLedger.count({ where: { requestId: event.idempotencyKey } })).toBe(0);
  });
});
