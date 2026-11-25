/** Card 27.5: sync settings and source fetching without a database or the internet. */
import { describe, expect, it } from 'vitest';

import { type CatalogSyncConfig, fetchSource, resolveSyncConfig } from './catalog-sync.js';

const defaults: CatalogSyncConfig = {
  enabled: true,
  sources: ['https://example.test/prices.json'],
  mode: 'manual',
  maxChangeFactor: 3,
  timeoutMs: 1_000,
  maxBytes: 1_000,
};

const respond =
  (body: string, init: ResponseInit = {}) =>
  () =>
    Promise.resolve(new Response(body, init));

describe('resolveSyncConfig', () => {
  it('lets stored admin settings override the environment', () => {
    expect(
      resolveSyncConfig(defaults, {
        enabled: false,
        sources: ['https://mirror.internal/prices.json'],
        mode: 'auto',
      }),
    ).toMatchObject({
      enabled: false,
      sources: ['https://mirror.internal/prices.json'],
      mode: 'auto',
      maxChangeFactor: 3,
    });
    expect(resolveSyncConfig(defaults, { sources: [] }).sources).toEqual(defaults.sources);
  });

  it('ignores invalid stored settings', () => {
    expect(resolveSyncConfig(defaults, { mode: 'yolo' })).toEqual(defaults);
    expect(resolveSyncConfig(defaults, null)).toEqual(defaults);
  });
});

describe('fetchSource', () => {
  const doc = JSON.stringify({
    'gpt-x': {
      litellm_provider: 'openai',
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    },
  });

  it('parses a valid document', async () => {
    const parsed = await fetchSource('u', { ...defaults, fetch: respond(doc) });
    expect(parsed.entries.map((e) => e.key)).toEqual(['openai/gpt-x']);
  });

  it('rejects HTTP errors, oversized and non-JSON bodies', async () => {
    await expect(
      fetchSource('u', { ...defaults, fetch: respond('', { status: 503 }) }),
    ).rejects.toThrow('HTTP 503');
    await expect(
      fetchSource('u', { ...defaults, fetch: respond('x'.repeat(2_000)) }),
    ).rejects.toThrow(/larger than/);
    await expect(fetchSource('u', { ...defaults, fetch: respond('{nope') })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('fails cleanly without network access', async () => {
    await expect(
      fetchSource('http://127.0.0.1:9/prices.json', { ...defaults, timeoutMs: 2_000 }),
    ).rejects.toThrow();
  });
});
