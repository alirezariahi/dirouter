/**
 * Upstream balance lookups (card 32.9).
 *
 * `lookupBalances` asks a provider's balance API for each enabled credential, with the same
 * credential token, proxy and SSRF guard as traffic. The control-api calls it through
 * `/internal/providers/balance` (the dashboard's refresh button), and `BalanceMonitor` runs it
 * periodically for every provider with a balance API: one replica per round (Valkey lock), and
 * samples go to a Valkey list the worker stores in `credential_balances`.
 */
import {
  type BalanceKind,
  type ConfigSnapshot,
  ProviderConfig,
  UPSTREAM_BALANCES_KEY,
  type UpstreamBalanceSample,
  UpstreamBalanceSettings,
} from '@dirouter/contracts';
import { balanceKind, balanceRequest, parseBalance } from '@dirouter/providers';
import { decrypt, type Keyring, type Logger, ValidationError } from '@dirouter/shared';
import { z } from 'zod';

import { resolveCredentialKey, tokenFailure } from './credential-tokens.js';
import { callUpstream, mergeTimeouts, readErrorBody } from './upstream.js';

export const BALANCE_LOCK_KEY = 'dirouter:balances:lock';
const SAMPLES_MAX = 5_000;

export const BalanceRequest = z.object({
  provider: ProviderConfig,
  credentialId: z.string().optional(),
});

async function lookupOne(
  provider: ProviderConfig,
  kind: BalanceKind,
  credentialId: string,
  keyring: Keyring,
  now: () => number,
): Promise<UpstreamBalanceSample> {
  const base = { providerId: provider.id, credentialId, kind };
  const credential = provider.credentials.find((c) => c.id === credentialId);
  const fail = (error: string): UpstreamBalanceSample => ({
    ...base,
    ok: false,
    error: error.slice(0, 300),
    checkedAt: new Date(now()).toISOString(),
  });
  if (!credential) return fail('credential not found');
  const proxyUrl = credential.proxy?.url ?? provider.proxy?.url;
  let key: string;
  try {
    key = await resolveCredentialKey(
      provider,
      credential,
      decrypt(keyring, credential.secret, credential.id),
      { signal: AbortSignal.timeout(15_000), proxyUrl },
    );
  } catch (error) {
    return fail(tokenFailure(error).message);
  }
  const timeouts = mergeTimeouts({ connectMs: 5_000, totalMs: 15_000 }, provider.timeouts);
  try {
    const call = await callUpstream(
      provider,
      balanceRequest(provider, kind, key),
      timeouts,
      AbortSignal.timeout(15_000),
      false,
      proxyUrl,
    );
    try {
      if (!call.response.ok)
        return fail(
          `HTTP ${String(call.response.status)}: ${(await readErrorBody(call.response, 200)).trim()}`,
        );
      const balance = parseBalance(kind, await call.response.json(), provider);
      if (!balance) return fail('the answer has no balance');
      return { ...base, ok: true, ...balance, checkedAt: new Date(now()).toISOString() };
    } finally {
      call.done();
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'balance lookup failed');
  }
}

/** Balances of the provider's enabled credentials (or one); empty when it has no balance API. */
export async function lookupBalances(
  provider: ProviderConfig,
  keyring: Keyring,
  options: { credentialId?: string | undefined; now?: () => number } = {},
): Promise<UpstreamBalanceSample[]> {
  const kind = balanceKind(provider);
  if (!kind) return [];
  const ids = options.credentialId
    ? [options.credentialId]
    : provider.credentials.filter((c) => c.enabled).map((c) => c.id);
  const out: UpstreamBalanceSample[] = [];
  for (const id of ids)
    out.push(await lookupOne(provider, kind, id, keyring, options.now ?? Date.now));
  return out;
}

/** Body of `/internal/providers/balance` (control-api), validated. */
export async function balanceForProbe(body: unknown, keyring: Keyring) {
  const parsed = BalanceRequest.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  const { provider, credentialId } = parsed.data;
  return {
    kind: balanceKind(provider) ?? null,
    balances: await lookupBalances(provider, keyring, { credentialId }),
  };
}

/** The subset of ioredis used here; lets tests pass a small fake. */
export interface BalanceRedis {
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null>;
  lpush(key: string, ...values: string[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
}

export class BalanceMonitor {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  rounds = 0;

  constructor(
    private readonly opts: {
      snapshot: () => ConfigSnapshot | undefined;
      keyring: Keyring;
      logger: Logger;
      instance: string;
      redis?: BalanceRedis;
      lookup?: typeof lookupBalances;
    },
  ) {}

  settings(): UpstreamBalanceSettings {
    return UpstreamBalanceSettings.parse(this.opts.snapshot()?.settings.upstreamBalance ?? {});
  }

  /** Re-arms after each round, so a changed interval applies without a restart. */
  start(firstDelayMs = 60_000): void {
    if (this.#timer) return;
    const schedule = (delay: number) => {
      this.#timer = setTimeout(() => {
        void this.round()
          .catch((error: unknown) => {
            this.opts.logger.warn({ err: error }, 'balance round failed');
          })
          .finally(() => {
            schedule(this.settings().intervalSeconds * 1_000);
          });
      }, delay);
      this.#timer.unref();
    };
    schedule(firstDelayMs);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async round(): Promise<UpstreamBalanceSample[]> {
    const settings = this.settings();
    const snapshot = this.opts.snapshot();
    if (!settings.enabled || !snapshot || this.#running) return [];
    this.#running = true;
    try {
      if (!(await this.#acquire(settings.intervalSeconds))) return [];
      const lookup = this.opts.lookup ?? lookupBalances;
      const samples: UpstreamBalanceSample[] = [];
      for (const provider of snapshot.providers) {
        if (!provider.enabled || !balanceKind(provider)) continue;
        samples.push(...(await lookup(provider, this.opts.keyring)));
      }
      this.rounds++;
      const redis = this.opts.redis;
      if (redis && samples.length > 0)
        try {
          await redis.lpush(UPSTREAM_BALANCES_KEY, ...samples.map((s) => JSON.stringify(s)));
          await redis.ltrim(UPSTREAM_BALANCES_KEY, 0, SAMPLES_MAX - 1);
        } catch {
          // The next round tries again.
        }
      return samples;
    } finally {
      this.#running = false;
    }
  }

  async #acquire(intervalSeconds: number): Promise<boolean> {
    const redis = this.opts.redis;
    if (!redis) return true;
    try {
      const got = await redis.set(
        BALANCE_LOCK_KEY,
        this.opts.instance,
        'PX',
        Math.max(1_000, intervalSeconds * 1_000 - 500),
        'NX',
      );
      return got === 'OK';
    } catch {
      return true;
    }
  }
}
