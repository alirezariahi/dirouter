/**
 * محدودیت تلاش ورود (کارت ۳.۴): ۱۰ تلاش ناموفق برای یک حساب در ۱۵ دقیقه آن را ۱۵ دقیقه
 * قفل می‌کند. سقف جدای ۱۰۰ تلاش برای هر IP جلوی password spraying روی حساب‌های مختلف را
 * می‌گیرد. شمارنده‌ها روی Valkey هستند (مشترک بین replicaها). اگر Valkey در دسترس نباشد،
 * شمارندهٔ حافظهٔ همان نود استفاده می‌شود: محافظت ضعیف‌تر می‌شود ولی از کار نمی‌افتد.
 */
import { createHash } from 'node:crypto';

export interface LimiterStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export const LOGIN_LIMITS = { account: 10, ip: 100, windowMs: 15 * 60_000 } as const;

const accountKey = (email: string) =>
  `dirouter:login:acct:${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 32)}`;
const ipKey = (ip: string) => `dirouter:login:ip:${ip}`;

class MemoryStore implements LimiterStore {
  readonly #m = new Map<string, { n: number; until: number }>();
  #entry(key: string) {
    const e = this.#m.get(key);
    if (e && e.until > Date.now()) return e;
    this.#m.delete(key);
    return undefined;
  }
  incr(key: string) {
    const e = this.#entry(key) ?? { n: 0, until: Date.now() + LOGIN_LIMITS.windowMs };
    e.n++;
    this.#m.set(key, e);
    return Promise.resolve(e.n);
  }
  pexpire(key: string, ms: number) {
    const e = this.#entry(key);
    if (e) e.until = Date.now() + ms;
    return Promise.resolve(e ? 1 : 0);
  }
  pttl(key: string) {
    const e = this.#entry(key);
    return Promise.resolve(e ? e.until - Date.now() : -2);
  }
  get(key: string) {
    const e = this.#entry(key);
    return Promise.resolve(e ? String(e.n) : null);
  }
  del(...keys: string[]) {
    for (const k of keys) this.#m.delete(k);
    return Promise.resolve(keys.length);
  }
}

export class LoginLimiter {
  readonly #fallback = new MemoryStore();
  constructor(private readonly store: LimiterStore) {}

  async #run<T>(fn: (s: LimiterStore) => Promise<T>): Promise<T> {
    try {
      return await fn(this.store);
    } catch {
      return fn(this.#fallback);
    }
  }

  /** اگر قفل است، میلی‌ثانیه تا باز شدن؛ وگرنه undefined. */
  lockedFor(email: string, ip: string): Promise<number | undefined> {
    return this.#run(async (s) => {
      for (const [key, limit] of [
        [accountKey(email), LOGIN_LIMITS.account],
        [ipKey(ip), LOGIN_LIMITS.ip],
      ] as const) {
        const n = Number((await s.get(key)) ?? 0);
        if (n >= limit) {
          const ttl = await s.pttl(key);
          return ttl > 0 ? ttl : LOGIN_LIMITS.windowMs;
        }
      }
      return undefined;
    });
  }

  failure(email: string, ip: string): Promise<void> {
    return this.#run(async (s) => {
      for (const key of [accountKey(email), ipKey(ip)]) {
        // پنجرهٔ ثابت از اولین شکست؛ قفل تا پایان همان پنجره می‌ماند.
        if ((await s.incr(key)) === 1) await s.pexpire(key, LOGIN_LIMITS.windowMs);
      }
    });
  }

  /** ورود موفق شمارندهٔ حساب را صفر می‌کند (شمارندهٔ IP می‌ماند). */
  success(email: string): Promise<void> {
    return this.#run(async (s) => {
      await s.del(accountKey(email));
    });
  }
}
