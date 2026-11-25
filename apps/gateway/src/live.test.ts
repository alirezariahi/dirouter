/** Live view feed (card 24.4): one publish per finished request on the organization's channel. */
import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { LivePublisher } from './live.js';

const event = (organizationId: string): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: '01JABCDEFGHJKMNPQRSTV00001',
  idempotencyKey: 'req_1',
  requestId: 'req_1',
  occurredAt: new Date().toISOString(),
  gatewayInstance: 'gw',
  configVersion: 1,
  organizationId,
  teamId: null,
  projectId: 'prj',
  virtualKeyId: 'vk',
  inboundApi: 'openai.chat',
  requestedModel: 'm',
  resolvedModelId: null,
  providerId: null,
  credentialId: null,
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
  costUsd: '0',
  usageEstimated: false,
  latencyMs: 5,
  attempts: [],
});

describe('LivePublisher', () => {
  it("publishes on the organization's channel and skips anonymous or offline cases", async () => {
    const sent: [string, string][] = [];
    const client = {
      status: 'ready',
      publish: (channel: string, message: string) => {
        sent.push([channel, message]);
        return Promise.resolve(1);
      },
    };
    const live = new LivePublisher(client);
    live.publish(event('org_1'));
    live.publish(event(''));
    client.status = 'reconnecting';
    live.publish(event('org_1'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.map(([channel]) => channel)).toEqual(['dirouter:live:org_1']);
    expect(JSON.parse(sent[0]?.[1] ?? '{}')).toMatchObject({ id: 'req_1', status: 'success' });
    expect(live.stats).toEqual({ published: 1, dropped: 2 });
  });
});
