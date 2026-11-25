import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { envSchema } from './env.js';
import { parseTrustProxy } from './trust-proxy.js';

/** What fastify reports as the client for one request through the given setting. */
async function seen(setting: string | undefined, remoteAddress: string, forwardedFor?: string) {
  const app = Fastify({ trustProxy: parseTrustProxy(setting) });
  app.get('/', (req) => ({ ip: req.ip, protocol: req.protocol }));
  const res = await app.inject({
    method: 'GET',
    url: '/',
    remoteAddress,
    headers: {
      'x-forwarded-proto': 'https',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
  });
  await app.close();
  return res.json<{ ip: string; protocol: string }>();
}

describe('TRUST_PROXY', () => {
  it('defaults to one hop: the address the nearest proxy saw, not one the client wrote', async () => {
    // A client sent "X-Forwarded-For: 203.0.113.9"; the proxy appended the real address.
    expect(await seen(undefined, '10.0.0.2', '203.0.113.9, 198.51.100.7')).toEqual({
      ip: '198.51.100.7',
      protocol: 'https',
    });
    expect(await seen('1', '10.0.0.2', '198.51.100.7')).toEqual({
      ip: '198.51.100.7',
      protocol: 'https',
    });
  });

  it('takes a hop count, a list of proxy addresses or ranges, or true/false', async () => {
    expect((await seen('2', '10.0.0.2', '203.0.113.9, 198.51.100.7, 10.0.0.3')).ip).toBe(
      '198.51.100.7',
    );
    // Only listed proxies are skipped; the first address that is not one of them is the client.
    expect((await seen('10.0.0.0/8, 192.0.2.1', '10.0.0.2', '203.0.113.9, 10.1.2.3')).ip).toBe(
      '203.0.113.9',
    );
    expect(await seen('10.0.0.0/8', '198.51.100.50', '203.0.113.9')).toEqual({
      ip: '198.51.100.50',
      protocol: 'http',
    });
    expect((await seen('false', '10.0.0.2', '203.0.113.9')).ip).toBe('10.0.0.2');
    expect((await seen('0', '10.0.0.2', '203.0.113.9')).ip).toBe('10.0.0.2');
    expect((await seen('true', '10.0.0.2', '203.0.113.9, 198.51.100.7')).ip).toBe('203.0.113.9');
  });

  it('refuses anything else when the environment is read', () => {
    const base = {
      DATABASE_URL: 'postgresql://x',
      VALKEY_URL: 'redis://x',
      MASTER_KEY: 'k',
      KEY_PEPPER: 'p'.repeat(32),
      JWT_SECRET: 'j'.repeat(32),
      INTERNAL_TOKEN: 'i'.repeat(32),
    };
    for (const bad of ['yes', '10.0.0.0/33', '10.0.0.1/8/1', 'proxy.local', '1000'])
      expect(
        envSchema.safeParse({ ...base, TRUST_PROXY: bad }).error?.issues.map((i) => i.path[0]),
      ).toContain('TRUST_PROXY');
    expect(parseTrustProxy(' 10.0.0.0/8 , fd00::/8 ')).toEqual(['10.0.0.0/8', 'fd00::/8']);
  });
});
