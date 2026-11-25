import { describe, expect, it } from 'vitest';

import { LiveRequestEvent, liveChannel, toLiveEvent } from './live.js';
import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from './usage-event.js';

describe('live events (card 24.4)', () => {
  it('turns a usage event into a log-row shaped event without end user or credential', () => {
    const event: UsageEvent = {
      schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
      eventId: '01JABCDEFGHJKMNPQRSTV00001',
      idempotencyKey: 'req_1',
      requestId: 'req_1',
      occurredAt: '2026-11-25T10:00:00.000Z',
      gatewayInstance: 'gw',
      configVersion: 1,
      organizationId: 'org_1',
      teamId: null,
      projectId: 'prj_1',
      virtualKeyId: 'vk_1',
      endUser: 'someone@example.com',
      inboundApi: 'openai.chat',
      requestedModel: 'smart',
      resolvedModelId: 'mdl_1',
      providerId: 'prv_1',
      credentialId: 'cred_secret',
      stream: true,
      status: 'success',
      httpStatus: 200,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: '0.00010000',
      usageEstimated: false,
      latencyMs: 300,
      ttftMs: 40,
      attempts: [],
    };
    const live = toLiveEvent(event);
    expect(LiveRequestEvent.parse(live)).toEqual(live);
    expect(live).toMatchObject({ id: 'req_1', apiKeyId: 'vk_1', errorCode: null, ttftMs: 40 });
    expect(JSON.stringify(live)).not.toMatch(/someone|cred_secret/);
    expect(liveChannel('org_1')).toBe('dirouter:live:org_1');
  });
});
