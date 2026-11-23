/**
 * Prepaid wallet reservations (card 19.1).
 *
 * Before a request of a prepaid organization reaches a provider, its worst-case charge (input
 * estimate plus the output cap, at the most expensive candidate's price) is reserved atomically in
 * Valkey. Concurrent requests therefore cannot spend the same credit twice. When the response ends
 * the reservation is replaced by the real charge; the worker removes it once the debit is posted to
 * the Postgres ledger. See `@dirouter/contracts` wallet.ts for the key layout and scripts.
 *
 * Valkey outage: failMode=open lets the request through (the worker debits what the wallet holds
 * and books any shortfall to the write-off account, so the balance still never goes negative), and
 * failMode=closed rejects it.
 */
import {
  type CanonicalUsage,
  type ModelPricing,
  unitsToUsd,
  usdToUnits,
  WALLET_HOLD_TTL_MS,
  WALLET_RESERVE_LUA,
  WALLET_SETTLE_LUA,
  WALLET_SETTLED_TTL_MS,
  walletHoldsKey,
  walletKey,
} from '@dirouter/contracts';
import { computeCost } from '@dirouter/model-catalog';
import { formatUsd, type Logger } from '@dirouter/shared';
import type { Redis } from 'ioredis';

import { withTimeout } from './budget-guard.js';

export type WalletReservation =
  | { ok: true; reserved: boolean }
  | { ok: false; availableUsd: string; neededUsd: string; unavailable?: boolean };

type RedisWithWallet = Redis & {
  walletReserve(...args: (string | number)[]): Promise<[number, number]>;
  walletSettle(...args: (string | number)[]): Promise<number>;
};

/** Output tokens assumed when neither the request nor the model sets a cap. */
export const DEFAULT_OUTPUT_RESERVATION = 4_096;

/**
 * Worst-case charge of a request: the estimated input plus the full output cap, priced at the most
 * expensive candidate (a fallback may land on any of them). `multiplier` turns cost into the sale
 * price (card 19.4).
 */
export function worstCaseChargeUsd(
  candidates: readonly {
    model: { pricing: ModelPricing; maxOutputTokens?: number | undefined };
  }[],
  estimatedInputTokens: number,
  maxOutputTokens: number | undefined,
  multiplier: (pricing: ModelPricing) => ModelPricing = (p) => p,
): string {
  let worst = 0n;
  for (const { model } of candidates) {
    const usage: CanonicalUsage = {
      inputTokens: Math.max(0, Math.ceil(estimatedInputTokens)),
      outputTokens: maxOutputTokens ?? model.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVATION,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const cost = computeCost(usage, multiplier(model.pricing)).total;
    if (cost > worst) worst = cost;
  }
  return formatUsd(worst);
}

export class WalletGuard {
  readonly #redis: RedisWithWallet | undefined;
  readonly #timeoutMs: number;
  readonly stats = { reserved: 0, rejected: 0, settled: 0, errors: 0 };

  constructor(
    private readonly options: {
      redis?: Redis;
      logger: Logger;
      failMode: () => 'open' | 'closed';
      commandTimeoutMs?: number;
      clock?: () => number;
    },
  ) {
    this.#timeoutMs = options.commandTimeoutMs ?? 100;
    if (options.redis) {
      const redis = options.redis as RedisWithWallet;
      redis.defineCommand('walletReserve', { numberOfKeys: 2, lua: WALLET_RESERVE_LUA });
      redis.defineCommand('walletSettle', { numberOfKeys: 2, lua: WALLET_SETTLE_LUA });
      this.#redis = redis;
    }
  }

  #now(): number {
    return this.options.clock?.() ?? Date.now();
  }

  async reserve(
    walletId: string,
    requestId: string,
    amountUsd: string,
  ): Promise<WalletReservation> {
    const redis = this.#redis;
    // Single node without Valkey: nothing to reserve against; the worker still debits the ledger.
    if (!redis) return { ok: true, reserved: false };
    const units = usdToUnits(amountUsd);
    try {
      const [status, available] = await withTimeout(
        redis.walletReserve(
          walletKey(walletId),
          walletHoldsKey(walletId),
          requestId,
          units,
          this.#now() + WALLET_HOLD_TTL_MS,
        ),
        this.#timeoutMs,
      );
      if (status === 1) {
        this.stats.reserved++;
        return { ok: true, reserved: true };
      }
      this.stats.rejected++;
      return {
        ok: false,
        availableUsd: unitsToUsd(Math.max(0, status === -1 ? 0 : available)),
        neededUsd: amountUsd,
      };
    } catch (error) {
      this.stats.errors++;
      this.options.logger.warn({ err: error, walletId }, 'wallet reservation failed (Valkey)');
      if (this.options.failMode() === 'open') return { ok: true, reserved: false };
      this.stats.rejected++;
      return { ok: false, availableUsd: '0', neededUsd: amountUsd, unavailable: true };
    }
  }

  /** Swaps the reservation for the real charge; never awaited and never throws. */
  settle(walletId: string, requestId: string, chargeUsd: string): void {
    const redis = this.#redis;
    if (!redis) return;
    void redis
      .walletSettle(
        walletKey(walletId),
        walletHoldsKey(walletId),
        requestId,
        Math.max(0, usdToUnits(chargeUsd)),
        this.#now() + WALLET_SETTLED_TTL_MS,
      )
      .then(() => {
        this.stats.settled++;
      })
      .catch((error: unknown) => {
        this.stats.errors++;
        // The hold expires on its own and the worker's reconcile recomputes `held`.
        this.options.logger.warn({ err: error, walletId }, 'wallet settle failed (Valkey)');
      });
  }
}
