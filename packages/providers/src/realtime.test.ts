/** Realtime WebSocket targets (card 30.5): URL and auth per provider type. */
import type { ModelConfig, ProviderConfig, ProviderType } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { realtimeTarget, supportsRealtime, toWebSocketUrl } from './realtime.js';

const ctx = (type: ProviderType, baseUrl: string, options = {}) => ({
  provider: {
    id: 'p',
    organizationId: 'o',
    slug: type,
    type,
    name: type,
    baseUrl,
    enabled: true,
    options,
    credentials: [],
  } satisfies ProviderConfig,
  model: {
    id: 'm',
    organizationId: 'o',
    slug: 'm',
    providerId: 'p',
    upstreamModel: 'gpt-realtime',
    enabled: true,
    pricing: { inputPerMTok: '0', outputPerMTok: '0' },
    capabilities: {
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
      jsonMode: false,
      embeddings: false,
    },
  } satisfies ModelConfig,
  apiKey: 'secret',
  credentialHeaders: { 'openai-project': 'proj_1' },
});

describe('realtime targets', () => {
  it('OpenAI and compatible servers: the base URL as ws(s), Bearer, beta header on request', () => {
    expect(realtimeTarget(ctx('openai', 'https://api.openai.com/v1/'), { beta: false })).toEqual({
      url: 'wss://api.openai.com/v1/realtime?model=gpt-realtime',
      headers: { authorization: 'Bearer secret', 'openai-project': 'proj_1' },
    });
    expect(
      realtimeTarget(ctx('openai-compatible', 'http://10.0.0.5:8000/v1'), { beta: true }),
    ).toEqual({
      url: 'ws://10.0.0.5:8000/v1/realtime?model=gpt-realtime',
      headers: {
        authorization: 'Bearer secret',
        'openai-beta': 'realtime=v1',
        'openai-project': 'proj_1',
      },
    });
  });

  it('Azure: the GA v1 path with api-key, the preview path for beta, Entra as Bearer', () => {
    const azure = 'https://acme.openai.azure.com';
    expect(realtimeTarget(ctx('azure-openai', azure), { beta: false })).toMatchObject({
      url: 'wss://acme.openai.azure.com/openai/v1/realtime?model=gpt-realtime',
      headers: { 'api-key': 'secret' },
    });
    expect(
      realtimeTarget(ctx('azure-openai', azure, { authMode: 'entra' }), { beta: true }),
    ).toMatchObject({
      url: 'wss://acme.openai.azure.com/openai/realtime?api-version=2025-04-01-preview&deployment=gpt-realtime',
      headers: { authorization: 'Bearer secret', 'openai-beta': 'realtime=v1' },
    });
  });

  it('other provider types have no realtime target', () => {
    expect(realtimeTarget(ctx('anthropic', 'https://api.anthropic.com'), { beta: false })).toBe(
      undefined,
    );
    expect(supportsRealtime('gemini')).toBe(false);
    expect(supportsRealtime('mock')).toBe(true);
    expect(toWebSocketUrl('https://h/v1///')).toBe('wss://h/v1');
  });
});
