import { describe, expect, it } from 'vitest';

import { slugify } from './auth.service.js';
import { hashPassword, TokenService, verifyPassword } from './crypto.js';
import { LOGIN_LIMITS, LoginLimiter, type LimiterStore } from './login-limiter.js';

describe('passwords', () => {
  it('hashes with argon2id and verifies only the right password', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong password!')).toBe(false);
    expect(await verifyPassword(undefined, 'anything')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });
});

describe('tokens', () => {
  const tokens = new TokenService('s'.repeat(32));

  it('signs and verifies a short-lived access token', async () => {
    const jwt = await tokens.signAccess({ sub: 'usr_1', email: 'a@b.c' });
    expect(await tokens.verifyAccess(jwt)).toEqual({ sub: 'usr_1', email: 'a@b.c' });
  });

  it('rejects tampered, foreign and expired tokens', async () => {
    const jwt = await tokens.signAccess({ sub: 'usr_1', email: 'a@b.c' });
    const [h, p, s] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'usr_admin', typ: 'access' })).toString(
      'base64url',
    );
    expect(await tokens.verifyAccess(`${h ?? ''}.${forged}.${s ?? ''}`)).toBeUndefined();
    expect(await new TokenService('x'.repeat(32)).verifyAccess(jwt)).toBeUndefined();
    const old = await tokens.signAccess({ sub: 'usr_1', email: 'a@b.c' }, Date.now() - 16 * 60_000);
    expect(await tokens.verifyAccess(old)).toBeUndefined();
    expect(p).toBeDefined();
  });

  it('refresh tokens are random and only their keyed hash is stored', () => {
    const a = tokens.newRefreshToken();
    const b = tokens.newRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(tokens.hashRefresh(a.token));
    expect(new TokenService('y'.repeat(32)).hashRefresh(a.token)).not.toBe(a.hash);
  });
});

/** store حافظه‌ای با همان معنای Valkey. */
function memoryStore(): LimiterStore & { broken: boolean } {
  const m = new Map<string, { n: number; until: number }>();
  const live = (k: string) => {
    const e = m.get(k);
    return e && e.until > Date.now() ? e : undefined;
  };
  const store = {
    broken: false,
    check() {
      if (store.broken) throw new Error('Connection is closed.');
    },
    incr(k: string) {
      store.check();
      const e = live(k) ?? { n: 0, until: Number.MAX_SAFE_INTEGER };
      e.n++;
      m.set(k, e);
      return Promise.resolve(e.n);
    },
    pexpire(k: string, ms: number) {
      store.check();
      const e = live(k);
      if (e) e.until = Date.now() + ms;
      return Promise.resolve(e ? 1 : 0);
    },
    pttl(k: string) {
      store.check();
      const e = live(k);
      return Promise.resolve(e ? e.until - Date.now() : -2);
    },
    get(k: string) {
      store.check();
      return Promise.resolve(live(k) ? String(live(k)?.n) : null);
    },
    del(...ks: string[]) {
      store.check();
      for (const k of ks) m.delete(k);
      return Promise.resolve(ks.length);
    },
  };
  return store;
}

describe('login limiter', () => {
  it('locks an account after 10 failures for the rest of the window', async () => {
    const limiter = new LoginLimiter(memoryStore());
    for (let i = 0; i < LOGIN_LIMITS.account - 1; i++) await limiter.failure('A@x.io', '1.1.1.1');
    expect(await limiter.lockedFor('a@x.io', '1.1.1.1')).toBeUndefined();
    await limiter.failure('a@x.io', '2.2.2.2');
    const ms = await limiter.lockedFor('a@x.io', '3.3.3.3');
    expect(ms).toBeGreaterThan(14 * 60_000);
    expect(ms).toBeLessThanOrEqual(LOGIN_LIMITS.windowMs);
    expect(await limiter.lockedFor('other@x.io', '3.3.3.3')).toBeUndefined();
  });

  it('a success resets the account counter', async () => {
    const limiter = new LoginLimiter(memoryStore());
    for (let i = 0; i < 9; i++) await limiter.failure('a@x.io', '1.1.1.1');
    await limiter.success('a@x.io');
    for (let i = 0; i < 9; i++) await limiter.failure('a@x.io', '1.1.1.1');
    expect(await limiter.lockedFor('a@x.io', '1.1.1.1')).toBeUndefined();
  });

  it('limits one IP across many accounts', async () => {
    const limiter = new LoginLimiter(memoryStore());
    for (let i = 0; i < LOGIN_LIMITS.ip; i++)
      await limiter.failure(`u${String(i)}@x.io`, '9.9.9.9');
    expect(await limiter.lockedFor('fresh@x.io', '9.9.9.9')).toBeDefined();
    expect(await limiter.lockedFor('fresh@x.io', '8.8.8.8')).toBeUndefined();
  });

  it('keeps limiting in memory when Valkey is down', async () => {
    const store = memoryStore();
    store.broken = true;
    const limiter = new LoginLimiter(store);
    for (let i = 0; i < 10; i++) await limiter.failure('a@x.io', '1.1.1.1');
    expect(await limiter.lockedFor('a@x.io', '1.1.1.1')).toBeDefined();
  });
});

describe('slugify', () => {
  it('makes url-safe slugs and falls back for non-latin names', () => {
    expect(slugify('  Acme Labs, Inc. ')).toBe('acme-labs-inc');
    expect(slugify('شرکت نمونه')).toMatch(/^org-[0-9a-z]{8}$/);
  });
});
