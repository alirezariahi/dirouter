import { describe, expect, it } from 'vitest';

import { LoginLimiter } from './login-limiter.js';

const failing = {
  incr: async () => {
    throw new Error('offline');
  },
  pexpire: async () => {
    throw new Error('offline');
  },
  pttl: async () => {
    throw new Error('offline');
  },
  get: async () => {
    throw new Error('offline');
  },
  del: async () => {
    throw new Error('offline');
  },
};

describe('login limiter fallback', () => {
  it('retains account and IP lockouts in memory during a Valkey outage', async () => {
    const limiter = new LoginLimiter(failing);
    for (let i = 0; i < 10; i++) await limiter.failure('User@Example.com', '10.0.0.1');
    expect(await limiter.lockedFor('user@example.com', '10.0.0.1')).toBeGreaterThan(0);
    await limiter.success('user@example.com');
    expect(await limiter.lockedFor('user@example.com', '10.0.0.1')).toBeUndefined();
    for (let i = 0; i < 100; i++) await limiter.failure('other@example.com', '10.0.0.2');
    expect(await limiter.lockedFor('other@example.com', '10.0.0.2')).toBeGreaterThan(0);
  });
});
