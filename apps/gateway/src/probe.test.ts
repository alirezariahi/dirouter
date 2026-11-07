/** تست اتصال و کشف مدل در گیت‌وی روی mock-provider واقعی (کارت ۳.۶). */
import type { ProviderConfig } from '@dirouter/contracts';
import { buildServer as buildMock } from '@dirouter/mock-provider/server';
import { encrypt, generateKey, parseKeyring } from '@dirouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { probeProvider } from './probe.js';

const keyring = parseKeyring(generateKey());
const mock = buildMock();
let root = '';

beforeAll(async () => {
  await mock.listen({ port: 0, host: '127.0.0.1' });
  const a = mock.server.address();
  root = `http://127.0.0.1:${String(typeof a === 'object' && a ? a.port : 0)}`;
});
afterAll(async () => {
  await mock.close();
});

const provider = (
  type: ProviderConfig['type'],
  secret: string,
  extra: Partial<ProviderConfig> = {},
): ProviderConfig => ({
  id: `p-${type}`,
  organizationId: 'org',
  slug: `p-${type}`,
  type,
  name: type,
  baseUrl: type === 'anthropic' ? root : `${root}/v1`,
  enabled: true,
  options: {},
  credentials: [
    {
      id: 'c1',
      name: 'c1',
      secret: encrypt(keyring, secret, 'c1'),
      enabled: true,
      weight: 1,
      headers: {},
    },
  ],
  ...extra,
});

describe('provider probe', () => {
  it('lists models with latency for openai-compatible and anthropic providers', async () => {
    for (const type of ['openai-compatible', 'anthropic'] as const) {
      const r = await probeProvider({ provider: provider(type, 'sk-x') }, keyring);
      expect(r).toMatchObject({ ok: true, status: 200 });
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      expect(r.models.map((m) => m.id)).toEqual(['mock-small', 'mock-large', 'mock-vision']);
    }
  });

  it('classifies a bad key and a dead proxy without throwing', async () => {
    const auth = await probeProvider(
      { provider: provider('openai-compatible', 'mock:auth') },
      keyring,
    );
    expect(auth).toMatchObject({ ok: false, status: 401, error: { class: 'auth' } });
    const dead = await probeProvider(
      {
        provider: provider('openai-compatible', 'sk-x', {
          proxy: { url: 'socks5://u:pw@127.0.0.1:1' },
        }),
      },
      keyring,
    );
    expect(dead).toMatchObject({ ok: false, error: { class: 'connection' } });
    expect(JSON.stringify(dead)).not.toContain(':pw@');
  });

  it('rejects an invalid request body', async () => {
    await expect(probeProvider({ provider: { id: 'x' } }, keyring)).rejects.toMatchObject({
      status: 422,
    });
  });
});
