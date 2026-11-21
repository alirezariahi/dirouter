/**
 * Hedged requests (card 12.2): after `afterMs` without a response, a second target starts in
 * parallel; the first success wins and the others are aborted. A hard cap (`maxParallel`) keeps
 * the per-request extra load bounded, and a rolling-window `HedgeBudget` bounds the share of
 * traffic that may ever be hedged.
 *
 * The first candidate always starts immediately. Retries are intentionally not repeated here:
 * hedging is for latency, and `executeWithFallback` still runs when hedging is disabled.
 */
import type { ClassifiedError } from '@dirouter/providers';

import type { AttemptFn, AttemptRecord, AttemptResult } from './executor.js';
import type { Candidate } from './router.js';

/** Rolling-window cap: at most `ratio` of new requests may start a hedge attempt. */
export class HedgeBudget {
  readonly #ratio: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  readonly #requests: number[] = [];
  readonly #hedges: number[] = [];

  constructor(options: { ratio?: number; windowMs?: number; clock?: () => number } = {}) {
    this.#ratio = Math.max(0, Math.min(1, options.ratio ?? 0.2));
    this.#windowMs = options.windowMs ?? 60_000;
    this.#clock = options.clock ?? Date.now;
  }

  /** Counts the request itself; call once per client request before the first attempt. */
  recordRequest(): void {
    this.#sweep();
    this.#requests.push(this.#clock());
  }

  /** true when an extra (hedged) attempt is allowed within the current window. */
  tryAcquire(): boolean {
    this.#sweep();
    if (this.#ratio <= 0) return false;
    if (this.#hedges.length / Math.max(1, this.#requests.length) >= this.#ratio) return false;
    const now = this.#clock();
    this.#hedges.push(now);
    return true;
  }

  stats(): { requests: number; hedges: number; ratio: number } {
    this.#sweep();
    return {
      requests: this.#requests.length,
      hedges: this.#hedges.length,
      ratio: this.#hedges.length / Math.max(1, this.#requests.length),
    };
  }

  #sweep(): void {
    const cutoff = this.#clock() - this.#windowMs;
    const dropBefore = (list: number[]) => {
      let i = 0;
      while (i < list.length && (list[i] ?? 0) < cutoff) i++;
      list.splice(0, i);
    };
    dropBefore(this.#requests);
    dropBefore(this.#hedges);
  }
}

export interface HedgeOptions {
  /** Delay before the first hedge attempt starts. */
  afterMs: number;
  /** Maximum simultaneous attempts (2..4). */
  maxParallel: number;
  /** Traffic budget; without it hedging is unbounded (tests/local use). */
  budget?: HedgeBudget;
  /** Client disconnect. */
  signal?: AbortSignal;
  /** Overall deadline (absolute ms). */
  deadline?: number;
  /**
   * true once one attempt owns the client response (a streaming attempt that has started
   * writing). From then on no further attempt is started; the caller aborts the others.
   */
  claimed?: () => boolean;
  clock?: () => number;
}

export type HedgeResult<T> =
  | {
      ok: true;
      value: T;
      candidate: Candidate;
      attempts: AttemptRecord[];
      hedged: boolean;
      /** Additional attempts started after the first one. */
      hedgeAttempts: number;
    }
  | {
      ok: false;
      error: ClassifiedError | undefined;
      reason: 'exhausted' | 'aborted' | 'committed' | 'deadline';
      attempts: AttemptRecord[];
      candidate?: Candidate;
      hedgeAttempts: number;
    };

export async function executeWithHedging<T>(
  candidates: readonly Candidate[],
  fn: AttemptFn<T>,
  options: HedgeOptions,
): Promise<HedgeResult<T>> {
  if (candidates.length === 0)
    return { ok: false, error: undefined, reason: 'exhausted', attempts: [], hedgeAttempts: 0 };
  const clock = options.clock ?? Date.now;
  const maxParallel = Math.max(1, Math.min(4, options.maxParallel));
  const afterMs = Math.max(0, options.afterMs);
  const attempts: AttemptRecord[] = [];
  const controllers = new Set<AbortController>();
  const queue = [...candidates];
  let started = 0;
  let finished = 0;
  let settled = false;
  let lastError: ClassifiedError | undefined;
  let lastCandidate: Candidate | undefined;
  let hedged = false;

  return await new Promise<HedgeResult<T>>((resolve) => {
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: HedgeResult<T>) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      for (const c of controllers) c.abort(new Error('hedge settled'));
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onAbort = () => {
      finish({
        ok: false,
        error: undefined,
        reason: 'aborted',
        attempts,
        ...(lastCandidate ? { candidate: lastCandidate } : {}),
        hedgeAttempts: started - 1,
      });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const launch = () => {
      if (settled || options.claimed?.()) return;
      if (options.deadline !== undefined && clock() >= options.deadline) {
        // Nothing is running any more: settle now, otherwise the promise would never resolve
        // when the last attempt fails after the deadline with candidates still queued.
        if (finished >= started)
          finish({
            ok: false,
            error: lastError,
            reason: 'deadline',
            attempts,
            ...(lastCandidate ? { candidate: lastCandidate } : {}),
            hedgeAttempts: started - 1,
          });
        return;
      }
      const candidate = queue.shift();
      if (!candidate) return;
      started += 1;
      if (started > 1) hedged = true;
      lastCandidate = candidate;
      const controller = new AbortController();
      controllers.add(controller);
      const startedAt = clock();
      const record = (outcome: AttemptRecord['outcome'], error?: ClassifiedError) => {
        attempts.push({
          providerId: candidate.provider.id,
          modelId: candidate.model.id,
          credentialId: candidate.credential.id,
          attempt: 1,
          outcome,
          ...(error ? { errorClass: error.class } : {}),
          ...(error?.status !== undefined ? { status: error.status } : {}),
          ...(error ? { message: error.message } : {}),
          startedAt,
          latencyMs: clock() - startedAt,
        });
      };

      void fn(candidate, controller.signal, 1).then(
        (result: AttemptResult<T>) => {
          controllers.delete(controller);
          if (settled) return;
          if (result.ok) {
            record('success');
            finish({
              ok: true,
              value: result.value,
              candidate,
              attempts,
              hedged,
              hedgeAttempts: started - 1,
            });
            return;
          }
          record('error', result.error);
          lastError = result.error;
          if (result.committed) {
            finish({
              ok: false,
              error: result.error,
              reason: 'committed',
              attempts,
              candidate,
              hedgeAttempts: started - 1,
            });
            return;
          }
          finished += 1;
          // A failing worker does not wait for the hedge timer: start the next target now, but
          // only for errors another target could fix (a 400 is not replayed across providers).
          if (result.error.fallbackAllowed) launch();
          // Nothing left running (no fallback, empty queue or deadline): the request is over.
          // `finish` ignores repeated calls, so no settled check is needed here.
          if (finished >= started)
            finish({
              ok: false,
              error: lastError,
              reason: 'exhausted',
              attempts,
              ...(lastCandidate ? { candidate: lastCandidate } : {}),
              hedgeAttempts: started - 1,
            });
        },
        (error: unknown) => {
          controllers.delete(controller);
          if (settled) return;
          record('error');
          finished += 1;
          lastError = {
            class: 'server',
            retryable: true,
            fallbackAllowed: true,
            message: error instanceof Error ? error.message : 'hedged attempt failed',
          };
          launch();
          if (finished >= started)
            finish({
              ok: false,
              error: lastError,
              reason: 'exhausted',
              attempts,
              ...(lastCandidate ? { candidate: lastCandidate } : {}),
              hedgeAttempts: started - 1,
            });
        },
      );
    };

    launch();
    const scheduleHedge = () => {
      if (settled || started >= maxParallel || queue.length === 0) return;
      hedgeTimer = setTimeout(() => {
        if (settled || options.claimed?.()) return;
        // The traffic budget only gates extra parallel attempts, never failure fallback.
        if (options.budget && !options.budget.tryAcquire()) return;
        launch();
        scheduleHedge();
      }, afterMs);
      hedgeTimer.unref();
    };
    scheduleHedge();
  });
}
