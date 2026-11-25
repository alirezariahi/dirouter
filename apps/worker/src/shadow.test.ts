import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { writeShadow } from './shadow.js';

const event = (shadow?: UsageEvent['shadow']): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: '01JABCDEFGHJKMNPQRSTVW0001',
  idempotencyKey: 'req_1:shadow:shd_1',
  requestId: 'req_1:shadow',
  occurredAt: '2026-11-26T10:00:00.000Z',
  gatewayInstance: 'gw',
  configVersion: 1,
  organizationId: 'org',
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
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: '0.00002000',
  chargeUsd: '0.00000000',
  usageEstimated: false,
  latencyMs: 900,
  attempts: [],
  ...(shadow ? { shadow } : {}),
});

describe('shadow copies (card 32.4)', () => {
  it('go to their own table only, with what they compare against', async () => {
    const rows: unknown[] = [];
    const db = {
      shadowRequest: {
        createMany: (args: { data: unknown[] }) => {
          rows.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        },
      },
    };
    expect(await writeShadow(db, event())).toBe(false);
    expect(rows).toEqual([]);
    const shadow = {
      policyId: 'shd_1',
      primaryRequestId: 'req_1',
      primaryModel: 'big',
      primaryStatus: 200,
      primaryLatencyMs: 120,
      primaryCostUsd: '0.00100000',
    };
    expect(await writeShadow(db, event(shadow))).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'req_1:shadow',
        organizationId: 'org',
        policyId: 'shd_1',
        primaryRequestId: 'req_1',
        modelId: 'mdl_next',
        costUsd: '0.00002000',
        latencyMs: 900,
        primaryModel: 'big',
        primaryLatencyMs: 120,
        primaryCostUsd: '0.00100000',
      }),
    ]);
  });
});
