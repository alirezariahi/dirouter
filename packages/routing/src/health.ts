/**
 * وضعیت سلامت در حافظهٔ هر نود (کارت‌های ۵.۵ و ۵.۶):
 * - circuit breaker برای provider و برای مدل (پنجرهٔ لغزان نرخ خطا + حداقل حجم)
 * - cooldown هر credential (429)، lockout مدل روی credential، غیرفعال‌سازی credential (auth)
 *
 * همگام‌سازی بین نودها (Valkey) بیرون از این کلاس است: تغییرات با `onChange`
 * منتشر و وضعیت راه دور با `applyRemote` اعمال می‌شود. قطعی Valkey فقط همگام‌سازی
 * را متوقف می‌کند؛ breaker محلی همچنان کار می‌کند.
 */
import type { ClassifiedError } from '@dirouter/providers';

export type Clock = () => number;

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  /** طول پنجرهٔ لغزان. */
  windowMs: number;
  buckets: number;
  /** حداقل تعداد درخواست در پنجره پیش از تصمیم. */
  minRequests: number;
  /** نرخ خطا (۰ تا ۱) که breaker را باز می‌کند. */
  errorThreshold: number;
  /** مدت باز ماندن اولیه؛ هر باز شدن پشت‌سرهم دو برابر می‌شود تا سقف. */
  openMs: number;
  maxOpenMs: number;
  /** تعداد probe هم‌زمان در half-open. */
  halfOpenProbes: number;
  /** موفقیت لازم در half-open برای بسته شدن. */
  closeAfterSuccesses: number;
}

export const DEFAULT_BREAKER: BreakerOptions = {
  windowMs: 30_000,
  buckets: 10,
  minRequests: 10,
  errorThreshold: 0.5,
  openMs: 15_000,
  maxOpenMs: 300_000,
  halfOpenProbes: 1,
  closeAfterSuccesses: 2,
};

/** خطاهایی که نشانهٔ ناسالم بودن provider/مدل‌اند (نه خطای کاربر یا کلید). */
const BREAKER_CLASSES = new Set(['server', 'overloaded', 'timeout', 'connection']);

export class CircuitBreaker {
  readonly #opts: BreakerOptions;
  readonly #clock: Clock;
  readonly #bucketMs: number;
  /** [شروع سطل، کل، خطا] */
  readonly #ring: { start: number; total: number; errors: number }[];
  #state: BreakerState = 'closed';
  #openedAt = 0;
  #openFor = 0;
  #consecutiveOpens = 0;
  #inFlightProbes = 0;
  #probeSuccesses = 0;

  constructor(opts: BreakerOptions, clock: Clock) {
    this.#opts = opts;
    this.#clock = clock;
    this.#bucketMs = Math.ceil(opts.windowMs / opts.buckets);
    this.#ring = Array.from({ length: opts.buckets }, () => ({ start: 0, total: 0, errors: 0 }));
  }

  get state(): BreakerState {
    if (this.#state === 'open' && this.#clock() - this.#openedAt >= this.#openFor) {
      this.#state = 'half_open';
      this.#inFlightProbes = 0;
      this.#probeSuccesses = 0;
    }
    return this.#state;
  }

  /** زمان باز شدن دوباره (برای Health)؛ فقط در حالت open. */
  get reopensAt(): number | undefined {
    return this.#state === 'open' ? this.#openedAt + this.#openFor : undefined;
  }

  /** آیا درخواست جدید مجاز است؟ در half-open فقط تعداد محدود probe. */
  allow(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    return this.#inFlightProbes < this.#opts.halfOpenProbes;
  }

  /** ثبت شروع درخواست (برای شمارش probe در half-open). */
  begin(): void {
    if (this.state === 'half_open') this.#inFlightProbes++;
  }

  record(success: boolean): BreakerState {
    const state = this.state;
    if (state === 'half_open') {
      this.#inFlightProbes = Math.max(0, this.#inFlightProbes - 1);
      if (!success) {
        this.#open();
      } else if (++this.#probeSuccesses >= this.#opts.closeAfterSuccesses) {
        this.#state = 'closed';
        this.#consecutiveOpens = 0;
        this.#reset();
      }
      return this.#state;
    }
    if (state === 'open') return state;

    const bucket = this.#bucket();
    bucket.total++;
    if (!success) bucket.errors++;
    if (!success) {
      const { total, errors } = this.#totals();
      if (total >= this.#opts.minRequests && errors / total >= this.#opts.errorThreshold)
        this.#open();
    }
    return this.#state;
  }

  /** تحمیل وضعیت از نود دیگر (همگام‌سازی). */
  force(state: BreakerState, reopensAt?: number): void {
    if (state === 'open') {
      this.#state = 'open';
      const now = this.#clock();
      this.#openedAt = now;
      this.#openFor = Math.max(0, (reopensAt ?? now + this.#opts.openMs) - now);
    } else if (state === 'closed') {
      this.#state = 'closed';
      this.#reset();
    }
  }

  stats(): { total: number; errors: number } {
    return this.#totals();
  }

  #open(): void {
    this.#state = 'open';
    this.#openedAt = this.#clock();
    this.#openFor = Math.min(this.#opts.maxOpenMs, this.#opts.openMs * 2 ** this.#consecutiveOpens);
    this.#consecutiveOpens++;
    this.#reset();
  }

  #bucket() {
    const now = this.#clock();
    const start = now - (now % this.#bucketMs);
    const slot = this.#ring[Math.floor(start / this.#bucketMs) % this.#ring.length];
    if (!slot) throw new Error('breaker ring is empty');
    if (slot.start !== start) {
      slot.start = start;
      slot.total = 0;
      slot.errors = 0;
    }
    return slot;
  }

  #totals() {
    const cutoff = this.#clock() - this.#opts.windowMs;
    let total = 0;
    let errors = 0;
    for (const b of this.#ring) {
      if (b.start > cutoff) {
        total += b.total;
        errors += b.errors;
      }
    }
    return { total, errors };
  }

  #reset(): void {
    for (const b of this.#ring) {
      b.start = 0;
      b.total = 0;
      b.errors = 0;
    }
  }
}

export type HealthChange =
  | {
      kind: 'breaker';
      scope: 'provider' | 'model';
      id: string;
      state: BreakerState;
      reopensAt?: number;
    }
  | { kind: 'cooldown'; credentialId: string; until: number }
  | { kind: 'lockout'; credentialId: string; modelId: string; until: number }
  | { kind: 'credential_disabled'; credentialId: string; reason: string };

export interface HealthOptions {
  breaker?: Partial<BreakerOptions>;
  /** cooldown پیش‌فرض 429 بدون Retry-After؛ با تکرار دو برابر می‌شود. */
  cooldownMs?: number;
  maxCooldownMs?: number;
  /** مدت غیرفعال بودن credential بعد از خطای auth (تا بررسی/تست دستی یا تغییر کلید). */
  disableMs?: number;
  clock?: Clock;
  onChange?: (change: HealthChange) => void;
}

export interface CredentialHealth {
  credentialId: string;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: string;
  lockouts: { modelId: string; until: number }[];
}

export class HealthRegistry {
  readonly #breakerOpts: BreakerOptions;
  readonly #clock: Clock;
  readonly #onChange: (change: HealthChange) => void;
  readonly #cooldownMs: number;
  readonly #maxCooldownMs: number;
  readonly #disableMs: number;
  readonly #providers = new Map<string, CircuitBreaker>();
  readonly #models = new Map<string, CircuitBreaker>();
  readonly #cooldowns = new Map<string, { until: number; strikes: number }>();
  readonly #lockouts = new Map<string, number>();
  readonly #disabled = new Map<string, { until: number; reason: string }>();

  constructor(options: HealthOptions = {}) {
    this.#breakerOpts = { ...DEFAULT_BREAKER, ...options.breaker };
    this.#clock = options.clock ?? Date.now;
    this.#onChange = options.onChange ?? (() => undefined);
    this.#cooldownMs = options.cooldownMs ?? 10_000;
    this.#maxCooldownMs = options.maxCooldownMs ?? 300_000;
    this.#disableMs = options.disableMs ?? 3_600_000;
  }

  now(): number {
    return this.#clock();
  }

  providerBreaker(id: string): CircuitBreaker {
    let b = this.#providers.get(id);
    if (!b) this.#providers.set(id, (b = new CircuitBreaker(this.#breakerOpts, this.#clock)));
    return b;
  }

  modelBreaker(id: string): CircuitBreaker {
    let b = this.#models.get(id);
    if (!b) this.#models.set(id, (b = new CircuitBreaker(this.#breakerOpts, this.#clock)));
    return b;
  }

  /** credential برای این مدل قابل استفاده است؟ */
  credentialAvailable(credentialId: string, modelId: string): boolean {
    const now = this.#clock();
    const disabled = this.#disabled.get(credentialId);
    if (disabled && disabled.until > now) return false;
    const cooldown = this.#cooldowns.get(credentialId);
    if (cooldown && cooldown.until > now) return false;
    const lock = this.#lockouts.get(`${credentialId}:${modelId}`);
    return !(lock !== undefined && lock > now);
  }

  recordSuccess(target: { providerId: string; modelId: string; credentialId: string }): void {
    this.#recordBreakers(target, true);
    // موفقیت بعد از cooldown شمارندهٔ backoff را صفر می‌کند.
    const cooldown = this.#cooldowns.get(target.credentialId);
    if (cooldown && cooldown.until <= this.#clock()) this.#cooldowns.delete(target.credentialId);
  }

  recordFailure(
    target: { providerId: string; modelId: string; credentialId: string },
    error: ClassifiedError,
  ): void {
    if (BREAKER_CLASSES.has(error.class)) this.#recordBreakers(target, false);
    else this.#recordBreakers(target, true); // خطای کاربر/کلید نشانهٔ سلامت سرویس است

    const now = this.#clock();
    if (error.credentialAction === 'disable') {
      const reason = `${error.class}: ${error.message}`.slice(0, 200);
      this.#disabled.set(target.credentialId, { until: now + this.#disableMs, reason });
      this.#onChange({ kind: 'credential_disabled', credentialId: target.credentialId, reason });
      return;
    }
    if (error.class === 'rate_limit') {
      // محدودیت مخصوص مدل (مثلاً «rate limit for model X») فقط همان مدل را قفل می‌کند.
      const modelScoped =
        /model|tokens per min|TPM/i.test(error.message) &&
        !/organization|account/i.test(error.message);
      const prev = this.#cooldowns.get(target.credentialId);
      const strikes = (prev?.strikes ?? 0) + 1;
      const duration =
        error.retryAfterMs ?? Math.min(this.#maxCooldownMs, this.#cooldownMs * 2 ** (strikes - 1));
      const until = now + duration;
      if (modelScoped) {
        this.#lockouts.set(`${target.credentialId}:${target.modelId}`, until);
        this.#onChange({
          kind: 'lockout',
          credentialId: target.credentialId,
          modelId: target.modelId,
          until,
        });
      } else {
        this.#cooldowns.set(target.credentialId, { until, strikes });
        this.#onChange({ kind: 'cooldown', credentialId: target.credentialId, until });
      }
    }
  }

  /** اعمال تغییر دریافتی از نود دیگر. */
  applyRemote(change: HealthChange): void {
    switch (change.kind) {
      case 'breaker':
        (change.scope === 'provider'
          ? this.providerBreaker(change.id)
          : this.modelBreaker(change.id)
        ).force(change.state, change.reopensAt);
        break;
      case 'cooldown': {
        const prev = this.#cooldowns.get(change.credentialId);
        this.#cooldowns.set(change.credentialId, {
          until: Math.max(prev?.until ?? 0, change.until),
          strikes: prev?.strikes ?? 1,
        });
        break;
      }
      case 'lockout':
        this.#lockouts.set(`${change.credentialId}:${change.modelId}`, change.until);
        break;
      case 'credential_disabled':
        this.#disabled.set(change.credentialId, {
          until: this.#clock() + this.#disableMs,
          reason: change.reason,
        });
        break;
    }
  }

  /** فعال‌سازی دوبارهٔ credential (مثلاً بعد از تغییر کلید در snapshot جدید). */
  enableCredential(credentialId: string): void {
    this.#disabled.delete(credentialId);
    this.#cooldowns.delete(credentialId);
  }

  /** نمای وضعیت برای /health/runtime و صفحهٔ Health. */
  report() {
    const now = this.#clock();
    const breakers = (map: Map<string, CircuitBreaker>) =>
      [...map].map(([id, b]) => ({
        id,
        state: b.state,
        ...b.stats(),
        ...(b.reopensAt ? { reopensAt: b.reopensAt } : {}),
      }));
    const credentials = new Map<string, CredentialHealth>();
    const entry = (id: string) => {
      let e = credentials.get(id);
      if (!e) credentials.set(id, (e = { credentialId: id, lockouts: [] }));
      return e;
    };
    for (const [id, c] of this.#cooldowns) if (c.until > now) entry(id).cooldownUntil = c.until;
    for (const [id, d] of this.#disabled) {
      if (d.until > now)
        Object.assign(entry(id), { disabledUntil: d.until, disabledReason: d.reason });
    }
    for (const [key, until] of this.#lockouts) {
      if (until <= now) continue;
      const [credentialId = '', modelId = ''] = key.split(':');
      entry(credentialId).lockouts.push({ modelId, until });
    }
    return {
      providers: breakers(this.#providers),
      models: breakers(this.#models),
      credentials: [...credentials.values()],
    };
  }

  #recordBreakers(target: { providerId: string; modelId: string }, success: boolean): void {
    for (const [scope, id, breaker] of [
      ['provider', target.providerId, this.providerBreaker(target.providerId)],
      ['model', target.modelId, this.modelBreaker(target.modelId)],
    ] as const) {
      const before = breaker.state;
      const after = breaker.record(success);
      if (after !== before)
        this.#onChange({
          kind: 'breaker',
          scope,
          id,
          state: after,
          ...(breaker.reopensAt ? { reopensAt: breaker.reopensAt } : {}),
        });
    }
  }
}
