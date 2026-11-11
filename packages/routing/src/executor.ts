/**
 * Retry with backoff and fallback chain (card 5.3).
 *
 * - Retry on the same candidate with exponential backoff + full jitter (or Retry-After)
 * - Then the next candidate, if the error class allows fallback
 * - Global retry budget so traffic does not multiply during a full outage
 * - Overall request deadline
 * - Every attempt is recorded
 */
import type { RetryPolicy, UpstreamErrorClass } from '@dirouter/contracts';
import type { ClassifiedError } from '@dirouter/providers';

import type { HealthRegistry } from './health.js';
import type { Candidate } from './router.js';

export interface AttemptRecord {
  providerId: string;
  modelId: string;
  credentialId: string;
  /** Attempt number on this same candidate (1 = first). */
  attempt: number;
  outcome: 'success' | 'error' | 'skipped';
  errorClass?: UpstreamErrorClass;
  status?: number;
  message?: string;
  startedAt: number;
  latencyMs: number;
}

export type AttemptResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: ClassifiedError;
      /**
       * Part of the response has already been sent to the client (stream); no further attempts are allowed.
       */
      committed?: boolean;
    };

export type AttemptFn<T> = (
  candidate: Candidate,
  signal: AbortSignal,
  attempt: number,
) => Promise<AttemptResult<T>>;

/**
 * Retry budget: within each window, retries are capped at `ratio` times the initial requests
 * plus `minPerWindow`.
 */
export class RetryBudget {
  readonly #ratio: number;
  readonly #minPerWindow: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  #windowStart = 0;
  #requests = 0;
  #retries = 0;

  constructor(
    options: {
      ratio?: number;
      minPerWindow?: number;
      windowMs?: number;
      clock?: () => number;
    } = {},
  ) {
    this.#ratio = options.ratio ?? 0.2;
    this.#minPerWindow = options.minPerWindow ?? 10;
    this.#windowMs = options.windowMs ?? 10_000;
    this.#clock = options.clock ?? Date.now;
  }

  onRequest(): void {
    this.#roll();
    this.#requests++;
  }

  /** Acquire permission for one extra retry (or fallback); consumed if allowed. */
  tryAcquire(): boolean {
    this.#roll();
    if (this.#retries >= this.#requests * this.#ratio + this.#minPerWindow) return false;
    this.#retries++;
    return true;
  }

  #roll(): void {
    const now = this.#clock();
    if (now - this.#windowStart >= this.#windowMs) {
      this.#windowStart = now;
      this.#requests = 0;
      this.#retries = 0;
    }
  }
}

export interface ExecuteOptions {
  retry: RetryPolicy;
  fallbackOn: readonly UpstreamErrorClass[];
  /** Absolute time at which the overall request deadline ends (ms). */
  deadline: number;
  budget: RetryBudget;
  health?: HealthRegistry;
  /** Client disconnect signal. */
  signal?: AbortSignal;
  clock?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Local admission before each attempt (bulkhead, card 5.7). On rejection the candidate is skipped
   * without contacting upstream and without affecting the breaker or cooldown; the next candidate is tried.
   * release is called after the attempt (and stream) finishes.
   */
  admit?: (
    candidate: Candidate,
    signal: AbortSignal | undefined,
  ) => Promise<{ ok: true; release: () => void } | { ok: false; error: ClassifiedError }>;
}

export type ExecuteResult<T> =
  | { ok: true; value: T; candidate: Candidate; attempts: AttemptRecord[] }
  | {
      ok: false;
      error: ClassifiedError | undefined;
      reason: 'exhausted' | 'deadline' | 'budget' | 'committed' | 'aborted' | 'no_fallback';
      attempts: AttemptRecord[];
      candidate?: Candidate;
    };

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Provider-level error classes; after these, the remaining candidates of the same provider are skipped. */
const PROVIDER_LEVEL = new Set<UpstreamErrorClass>([
  'server',
  'overloaded',
  'connection',
  'timeout',
]);

export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

export async function executeWithFallback<T>(
  candidates: readonly Candidate[],
  fn: AttemptFn<T>,
  options: ExecuteOptions,
): Promise<ExecuteResult<T>> {
  const clock = options.clock ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const attempts: AttemptRecord[] = [];
  const failedProviders = new Set<string>();
  let lastError: ClassifiedError | undefined;
  let lastCandidate: Candidate | undefined;
  let contextFloor = 0;
  let first = true;

  options.budget.onRequest();

  for (const candidate of candidates) {
    const target = {
      providerId: candidate.provider.id,
      modelId: candidate.model.id,
      credentialId: candidate.credential.id,
    };
    if (failedProviders.has(candidate.provider.id)) {
      attempts.push({
        ...target,
        attempt: 0,
        outcome: 'skipped',
        message: 'provider failed earlier in this request',
        startedAt: clock(),
        latencyMs: 0,
      });
      continue;
    }
    if (contextFloor > 0 && (candidate.model.contextWindow ?? 0) <= contextFloor) {
      attempts.push({
        ...target,
        attempt: 0,
        outcome: 'skipped',
        message: 'context window not larger than failed target',
        startedAt: clock(),
        latencyMs: 0,
      });
      continue;
    }
    if (
      options.health &&
      !options.health.credentialAvailable(candidate.credential.id, candidate.model.id)
    ) {
      attempts.push({
        ...target,
        attempt: 0,
        outcome: 'skipped',
        message: 'credential in cooldown',
        startedAt: clock(),
        latencyMs: 0,
      });
      continue;
    }

    let rejected = false;
    for (let attempt = 1; attempt <= options.retry.maxAttempts; attempt++) {
      if (options.signal?.aborted)
        return { ok: false, error: lastError, reason: 'aborted', attempts };
      if (clock() >= options.deadline)
        return {
          ok: false,
          error: lastError,
          reason: 'deadline',
          attempts,
          ...(lastCandidate ? { candidate: lastCandidate } : {}),
        };
      if (!first && !options.budget.tryAcquire())
        return {
          ok: false,
          error: lastError,
          reason: 'budget',
          attempts,
          ...(lastCandidate ? { candidate: lastCandidate } : {}),
        };
      first = false;

      const admission = options.admit ? await options.admit(candidate, options.signal) : undefined;
      if (admission && !admission.ok) {
        lastError = admission.error;
        lastCandidate = candidate;
        rejected = true;
        attempts.push({
          ...target,
          attempt,
          outcome: 'skipped',
          errorClass: admission.error.class,
          message: admission.error.message,
          startedAt: clock(),
          latencyMs: 0,
        });
        break;
      }

      const startedAt = clock();
      const controller = new AbortController();
      const onAbort = () => {
        controller.abort(options.signal?.reason);
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      options.health?.providerBreaker(candidate.provider.id).begin();
      options.health?.modelBreaker(candidate.model.id).begin();
      let result: AttemptResult<T>;
      try {
        result = await fn(candidate, controller.signal, attempt);
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        if (admission?.ok) admission.release();
      }
      const latencyMs = clock() - startedAt;
      lastCandidate = candidate;

      if (result.ok) {
        options.health?.recordSuccess(target);
        attempts.push({ ...target, attempt, outcome: 'success', startedAt, latencyMs });
        return { ok: true, value: result.value, candidate, attempts };
      }

      const error = result.error;
      lastError = error;
      options.health?.recordFailure(target, error);
      attempts.push({
        ...target,
        attempt,
        outcome: 'error',
        errorClass: error.class,
        message: error.message,
        startedAt,
        latencyMs,
        ...(error.status !== undefined ? { status: error.status } : {}),
      });
      if (result.committed) return { ok: false, error, reason: 'committed', attempts, candidate };
      if (options.signal?.aborted)
        return { ok: false, error, reason: 'aborted', attempts, candidate };

      // Retry on the same candidate?
      const retryHere =
        error.retryable && error.class !== 'rate_limit' && attempt < options.retry.maxAttempts;
      if (retryHere) {
        const delay = error.retryAfterMs ?? backoffDelay(attempt, options.retry, random);
        if (clock() + delay >= options.deadline) break;
        await sleep(delay, options.signal);
        continue;
      }
      break;
    }

    // Rejected by bulkhead: move to the next candidate regardless of fallbackOn.
    if (rejected) continue;
    // Fall back to the next candidate?
    if (!lastError) continue;
    if (!lastError.fallbackAllowed || !options.fallbackOn.includes(lastError.class)) {
      return { ok: false, error: lastError, reason: 'no_fallback', attempts, candidate };
    }
    if (PROVIDER_LEVEL.has(lastError.class)) failedProviders.add(candidate.provider.id);
    if (lastError.class === 'context_length')
      contextFloor = Math.max(
        contextFloor,
        candidate.model.contextWindow ?? Number.MAX_SAFE_INTEGER,
      );
  }

  return {
    ok: false,
    error: lastError,
    reason: 'exhausted',
    attempts,
    ...(lastCandidate ? { candidate: lastCandidate } : {}),
  };
}
