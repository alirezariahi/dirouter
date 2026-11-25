/** OpenAI-compatible moderation requests (card 23.2). */
import type { ModelConfig, ProviderConfig } from '@dirouter/contracts';
import { describe, expect, it } from 'vitest';

import { adapterFor } from './adapters.js';

const provider = (type: ProviderConfig['type']) =>
  ({
    id: 'p',
    slug: 'p',
    type,
    baseUrl: 'https://api.example.com/v1/',
    options: {},
  }) as unknown as ProviderConfig;
const model = { upstreamModel: 'omni-moderation-latest' } as unknown as ModelConfig;

describe('moderation', () => {
  it('posts the texts to /moderations and parses flags and scores', () => {
    const adapter = adapterFor('openai');
    const built = adapter.buildModerationRequest?.({
      provider: provider('openai'),
      model,
      apiKey: 'k',
      texts: ['hello'],
    });
    expect(built?.url).toBe('https://api.example.com/v1/moderations');
    expect(built?.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(built?.body ?? '{}')).toEqual({
      model: 'omni-moderation-latest',
      input: ['hello'],
    });
    expect(
      adapter.parseModerationResponse?.({
        results: [
          {
            flagged: true,
            categories: { violence: true, hate: false },
            category_scores: { violence: 0.91, hate: 0.01 },
          },
        ],
      }),
    ).toEqual({
      results: [
        {
          flagged: true,
          categories: { violence: true, hate: false },
          scores: { violence: 0.91, hate: 0.01 },
        },
      ],
    });
    expect(() => adapter.parseModerationResponse?.({})).toThrow(/no results/);
  });

  it('is not offered by providers without a moderation endpoint', () => {
    expect(
      adapterFor('azure-openai').buildModerationRequest?.({
        provider: provider('azure-openai'),
        model,
        apiKey: 'k',
        texts: ['x'],
      }),
    ).toBeUndefined();
    expect('buildModerationRequest' in adapterFor('anthropic')).toBe(false);
  });
});
