import { USAGE_EVENT_SCHEMA_VERSION, type UsageEvent } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { createGatewayMetrics } from './metrics.js';

const event = (): UsageEvent => ({
  schemaVersion: USAGE_EVENT_SCHEMA_VERSION,
  eventId: '01JABCDEFGHJKMNPQRSTVW0000',
  idempotencyKey: 'req_sensitive',
  requestId: 'req_sensitive',
  occurredAt: '2026-11-07T10:15:00.000Z',
  gatewayInstance: 'gw-1',
  configVersion: 1,
  organizationId: 'org_sensitive',
  teamId: null,
  projectId: 'project_sensitive',
  virtualKeyId: 'key_sensitive',
  endUser: 'user_sensitive',
  inboundApi: 'openai.chat',
  requestedModel: 'gpt-test',
  resolvedModelId: 'gpt-test',
  providerId: 'provider-test',
  credentialId: 'credential_sensitive',
  stream: true,
  status: 'success',
  httpStatus: 200,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  costUsd: '0.00000000',
  usageEstimated: false,
  latencyMs: 250,
  ttftMs: 40,
  attempts: [],
});

describe('gateway Prometheus metrics', () => {
  it('records request/TTFT/attempt/streams without user, key or request labels', async () => {
    let state = 'open';
    const metrics = createGatewayMetrics({
      breakerStates: () => [{ scope: 'provider', provider: 'provider-test', model: '', state }],
      outbox: { size: () => Promise.resolve(7) },
    });
    metrics.observe(event());
    metrics.observeAttempt({
      provider: 'provider-test',
      model: 'gpt-test',
      outcome: 'error',
      latencyMs: 25,
    });
    metrics.reject('rate_limit', 'tokens');
    metrics.reject('budget', 'usd');
    metrics.streamStarted();
    let text = await metrics.registry.metrics();
    expect(text).toContain(
      'dirouter_gateway_requests_total{provider="provider-test",model="gpt-test",status="success"} 1',
    );
    expect(text).toContain(
      'dirouter_gateway_ttft_seconds_count{provider="provider-test",model="gpt-test"} 1',
    );
    expect(text).toContain(
      'dirouter_gateway_request_attempts_count{provider="provider-test",model="gpt-test"} 1',
    );
    expect(text).toContain(
      'dirouter_gateway_upstream_attempt_duration_seconds_count{provider="provider-test",model="gpt-test",outcome="error"} 1',
    );
    expect(text).toContain('dirouter_gateway_active_streams 1');
    expect(text).toContain('dirouter_gateway_usage_outbox_events 7');
    expect(text).toContain(
      'dirouter_gateway_breaker_state{scope="provider",provider="provider-test",model="",state="open"} 1',
    );
    expect(text).not.toContain('sensitive');
    metrics.streamEnded();
    state = 'closed';
    text = await metrics.registry.metrics();
    expect(text).toContain('dirouter_gateway_active_streams 0');
    expect(text).not.toContain('state="open"');
    expect(text).toContain('state="closed"} 0');
  });
});
