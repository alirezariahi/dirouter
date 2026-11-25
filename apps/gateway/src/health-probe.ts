/**
 * Periodic upstream health probes (card 12.3).
 *
 * Every round calls the cheap "list models" endpoint of each enabled credential (no tokens are
 * generated, so a probe costs nothing on usage-billed providers). The result:
 *  - is recorded as a sample (uptime history; the worker stores it in `provider_health_samples`);
 *  - after `failureThreshold` consecutive auth failures the credential is taken out of rotation;
 *  - a disabled credential that answers again `successThreshold` times is restored automatically.
 *
 * Probing is off by default (`settings.healthProbe.enabled`). With Valkey, replicas share a lock so
 * only one of them probes per round and the upstream sees a single request per credential.
 */
import type { ConfigSnapshot, HealthProbeSettings, ProviderConfig } from '@dirouter/contracts';
import type { HealthRegistry } from '@dirouter/routing';
import type { Keyring, Logger } from '@dirouter/shared';

import { probeProvider, type ProbeResult } from './probe.js';

export const HEALTH_SAMPLES_KEY = 'dirouter:health:samples';
export const HEALTH_PROBE_LOCK_KEY = 'dirouter:health:probe-lock';
/** Samples kept in Valkey while the worker is down; older ones are dropped first. */
export const HEALTH_SAMPLES_MAX = 20_000;

export interface HealthSample {
  providerId: string;
  credentialId: string;
  ok: boolean;
  status?: number;
  latencyMs: number;
  errorClass?: string;
  checkedAt: string;
}

/** The subset of ioredis used here; lets tests pass a small fake. */
export interface ProbeRedis {
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
}

export interface HealthProberOptions {
  snapshot: () => ConfigSnapshot | undefined;
  health: HealthRegistry;
  keyring: Keyring;
  logger: Logger;
  instance: string;
  redis?: ProbeRedis;
  /** Injected in tests; defaults to the real connection test from card 3.6. */
  probe?: (provider: ProviderConfig, credentialId: string) => Promise<ProbeResult>;
  onSample?: (sample: HealthSample) => void;
  now?: () => number;
  /**
   * Another kind of probe on the same machinery (card 32.9, scheduled channel tests): its
   * settings, its Valkey lock, the prefix of its disable reasons, the error classes that take a
   * credential out of rotation (default: `auth`) and the providers it looks at.
   */
  settings?: (snapshot: ConfigSnapshot | undefined) => Partial<HealthProbeSettings> | undefined;
  lockKey?: string;
  reasonPrefix?: string;
  disableOn?: readonly string[];
  eligible?: (provider: ProviderConfig, snapshot: ConfigSnapshot) => boolean;
}

const DEFAULTS: HealthProbeSettings = {
  enabled: false,
  intervalSeconds: 60,
  failureThreshold: 3,
  successThreshold: 1,
  maxPerRound: 50,
};

/** Reason prefix so the Health page can tell probe decisions from live-traffic ones. */
export const PROBE_REASON_PREFIX = 'health_probe';
/** Reason prefix of scheduled channel tests (card 32.9). */
export const CHANNEL_TEST_REASON_PREFIX = 'channel_test';

export class HealthProber {
  readonly #opts: HealthProberOptions;
  readonly #failures = new Map<string, number>();
  readonly #successes = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #cursor = 0;
  rounds = 0;
  probes = 0;

  constructor(opts: HealthProberOptions) {
    this.#opts = opts;
  }

  settings(): HealthProbeSettings {
    const snapshot = this.#opts.snapshot();
    const own = this.#opts.settings
      ? this.#opts.settings(snapshot)
      : snapshot?.settings.healthProbe;
    return { ...DEFAULTS, ...own };
  }

  get #prefix(): string {
    return this.#opts.reasonPrefix ?? PROBE_REASON_PREFIX;
  }

  /**
   * Re-arms itself after every round, so a changed interval (or enabling the feature in a new
   * snapshot) applies without a restart. While disabled it only re-checks the settings.
   */
  start(): void {
    if (this.#timer) return;
    const schedule = () => {
      const settings = this.settings();
      const delay = (settings.enabled ? settings.intervalSeconds : 30) * 1_000;
      this.#timer = setTimeout(() => {
        void this.round()
          .catch((error: unknown) => {
            this.#opts.logger.warn({ err: error }, 'health probe round failed');
          })
          .finally(schedule);
      }, delay);
      this.#timer.unref();
    };
    schedule();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One probe round; returns the samples taken (empty when disabled or another replica holds the lock). */
  async round(): Promise<HealthSample[]> {
    const settings = this.settings();
    const snapshot = this.#opts.snapshot();
    if (!settings.enabled || !snapshot || this.#running) return [];
    this.#running = true;
    try {
      if (!(await this.#acquire(settings.intervalSeconds))) return [];
      const eligible = this.#opts.eligible;
      const targets = snapshot.providers
        .filter((provider) => provider.enabled && (!eligible || eligible(provider, snapshot)))
        .flatMap((provider) =>
          provider.credentials
            .filter((credential) => credential.enabled)
            .map((credential) => ({ provider, credentialId: credential.id })),
        );
      this.#forget(new Set(targets.map((t) => t.credentialId)));
      if (targets.length === 0) return [];
      // A rotating window keeps a large fleet under `maxPerRound` calls per round.
      const count = Math.min(settings.maxPerRound, targets.length);
      const start = this.#cursor % targets.length;
      const picked = Array.from(
        { length: count },
        (_, i) => targets[(start + i) % targets.length],
      ).filter((t): t is (typeof targets)[number] => t !== undefined);
      this.#cursor = (start + count) % targets.length;

      const samples: HealthSample[] = [];
      for (const target of picked) {
        const sample = await this.#probeOne(target.provider, target.credentialId, settings);
        samples.push(sample);
      }
      this.rounds++;
      await this.#store(samples);
      return samples;
    } finally {
      this.#running = false;
    }
  }

  async #probeOne(
    provider: ProviderConfig,
    credentialId: string,
    settings: HealthProbeSettings,
  ): Promise<HealthSample> {
    const now = this.#opts.now ?? Date.now;
    const run =
      this.#opts.probe ??
      ((p: ProviderConfig, id: string) =>
        probeProvider({ provider: p, credentialId: id }, this.#opts.keyring));
    let result: ProbeResult;
    try {
      result = await run(provider, credentialId);
    } catch (error) {
      // Decrypt/validation problems are configuration errors, not upstream downtime.
      result = {
        ok: false,
        latencyMs: 0,
        error: { class: 'bad_request', message: error instanceof Error ? error.message : 'probe' },
        models: [],
      };
    }
    this.probes++;
    const sample: HealthSample = {
      providerId: provider.id,
      credentialId,
      ok: result.ok,
      ...(result.status !== undefined ? { status: result.status } : {}),
      latencyMs: Math.max(0, Math.round(result.latencyMs)),
      ...(result.error ? { errorClass: result.error.class } : {}),
      checkedAt: new Date(now()).toISOString(),
    };
    this.#apply(sample, result, settings);
    this.#opts.onSample?.(sample);
    return sample;
  }

  #apply(sample: HealthSample, result: ProbeResult, settings: HealthProbeSettings): void {
    const { health, logger } = this.#opts;
    const id = sample.credentialId;
    if (sample.ok) {
      this.#failures.delete(id);
      const disabled = health.credentialDisabledReason(id);
      // A model list answers even when the account has no credit left, so the health probe never
      // restores a credential a channel test took out (card 32.9); a real request proves both.
      if (
        disabled === undefined ||
        (this.#prefix !== CHANNEL_TEST_REASON_PREFIX &&
          disabled.startsWith(CHANNEL_TEST_REASON_PREFIX))
      ) {
        this.#successes.delete(id);
        return;
      }
      const streak = (this.#successes.get(id) ?? 0) + 1;
      if (streak >= settings.successThreshold) {
        this.#successes.delete(id);
        health.restoreCredential(id);
        logger.info(
          { credentialId: id, providerId: sample.providerId, by: this.#prefix },
          'credential re-enabled by health probe',
        );
      } else this.#successes.set(id, streak);
      return;
    }
    this.#successes.delete(id);
    // Only key-level failures disable a credential. Outages (5xx, timeout, connection) belong to the
    // provider breaker; disabling every key during an outage would hide the real cause.
    if (!(this.#opts.disableOn ?? ['auth']).includes(sample.errorClass ?? '')) {
      this.#failures.delete(id);
      return;
    }
    const streak = (this.#failures.get(id) ?? 0) + 1;
    this.#failures.set(id, streak);
    if (streak < settings.failureThreshold) return;
    if (health.credentialDisabledReason(id) !== undefined) return;
    const message = result.error?.message ?? 'authentication failed';
    health.disableCredential(id, `${this.#prefix}: ${message}`);
    logger.warn(
      { credentialId: id, providerId: sample.providerId, failures: streak, by: this.#prefix },
      'credential disabled by health probe',
    );
  }

  /** Drop counters of credentials that left the snapshot. */
  #forget(alive: Set<string>): void {
    for (const map of [this.#failures, this.#successes])
      for (const id of [...map.keys()]) if (!alive.has(id)) map.delete(id);
  }

  async #acquire(intervalSeconds: number): Promise<boolean> {
    const redis = this.#opts.redis;
    if (!redis) return true;
    try {
      // Slightly shorter than the interval so the next round is never blocked by this one.
      const ttl = Math.max(1_000, intervalSeconds * 1_000 - 500);
      const got = await redis.set(
        this.#opts.lockKey ?? HEALTH_PROBE_LOCK_KEY,
        this.#opts.instance,
        'PX',
        ttl,
        'NX',
      );
      return got === 'OK';
    } catch {
      // Valkey down: probing locally is still better than not probing.
      return true;
    }
  }

  async #store(samples: HealthSample[]): Promise<void> {
    const redis = this.#opts.redis;
    if (!redis || samples.length === 0) return;
    try {
      await redis.lpush(HEALTH_SAMPLES_KEY, ...samples.map((s) => JSON.stringify(s)));
      await redis.ltrim(HEALTH_SAMPLES_KEY, 0, HEALTH_SAMPLES_MAX - 1);
    } catch {
      // History is best-effort; the disable/enable decision above already happened.
    }
  }
}
