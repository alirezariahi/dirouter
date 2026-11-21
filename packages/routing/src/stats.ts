/**
 * Runtime routing statistics (card 12.1): EWMA latency, recent volume, in-flight counts and price
 * estimates used by the `latency`, `cost`, `least-used` and `headroom` combo strategies.
 *
 * Everything is in-memory and per replica: routing decisions never wait on the network, and a
 * restart only loses a short warm-up window.
 */
import type { ModelConfig } from '@dirouter/contracts';

export interface ModelStatsSnapshot {
  latencyMs?: number;
  /** PeakEWMA: reacts quickly to a slow tail and decays between observations. */
  peakLatencyMs?: number;
  recentRequests: number;
  inFlight: number;
  lastSuccessAt?: number;
}

const DEFAULT_ALPHA = 0.2;
const WINDOW_MS = 60_000;
const PEAK_DECAY_MS = 60_000;

export class RouterStats {
  readonly #latency = new Map<string, number>();
  readonly #peak = new Map<string, { value: number; at: number }>();
  readonly #requests = new Map<string, number[]>();
  readonly #inFlight = new Map<string, number>();
  readonly #lastSuccess = new Map<string, number>();
  readonly #alpha: number;
  readonly #decayMs: number;
  readonly #now: () => number;

  constructor(options: { alpha?: number; decayMs?: number; now?: () => number } = {}) {
    this.#alpha = options.alpha ?? DEFAULT_ALPHA;
    this.#decayMs = options.decayMs ?? PEAK_DECAY_MS;
    this.#now = options.now ?? Date.now;
  }

  recordLatency(modelId: string, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    const at = this.#now();
    const prev = this.#latency.get(modelId);
    this.#latency.set(
      modelId,
      prev === undefined ? latencyMs : prev * (1 - this.#alpha) + latencyMs * this.#alpha,
    );
    // PeakEWMA: decays exponentially and takes the maximum; the peak is aggressive on outliers.
    const peak = this.#peak.get(modelId);
    const decayed =
      peak === undefined
        ? latencyMs
        : peak.value * Math.exp(-Math.max(0, at - peak.at) / this.#decayMs);
    this.#peak.set(modelId, { value: Math.max(decayed, latencyMs), at });
    this.#lastSuccess.set(modelId, at);
  }

  /** PeakEWMA score; unknown models are always worse than every known one. */
  peakLatency(modelId: string): number | undefined {
    const peak = this.#peak.get(modelId);
    if (peak === undefined) return undefined;
    const decayed = peak.value * Math.exp(-Math.max(0, this.#now() - peak.at) / this.#decayMs);
    return Math.max(decayed, this.#latency.get(modelId) ?? 0);
  }

  lastSuccessAt(modelId: string): number | undefined {
    return this.#lastSuccess.get(modelId);
  }

  recordRequest(modelId: string): void {
    const now = this.#now();
    const list = this.#requests.get(modelId) ?? [];
    list.push(now);
    this.#requests.set(
      modelId,
      list.filter((t) => now - t < WINDOW_MS),
    );
  }

  begin(modelId: string): void {
    this.#inFlight.set(modelId, (this.#inFlight.get(modelId) ?? 0) + 1);
  }

  end(modelId: string): void {
    const n = (this.#inFlight.get(modelId) ?? 0) - 1;
    if (n <= 0) this.#inFlight.delete(modelId);
    else this.#inFlight.set(modelId, n);
  }

  snapshot(modelId: string): ModelStatsSnapshot {
    const now = this.#now();
    const recent = (this.#requests.get(modelId) ?? []).filter((t) => now - t < WINDOW_MS);
    const peak = this.peakLatency(modelId);
    const lastSuccess = this.#lastSuccess.get(modelId);
    return {
      ...(this.#latency.has(modelId) ? { latencyMs: this.#latency.get(modelId) } : {}),
      ...(peak !== undefined ? { peakLatencyMs: peak } : {}),
      recentRequests: recent.length,
      inFlight: this.#inFlight.get(modelId) ?? 0,
      ...(lastSuccess !== undefined ? { lastSuccessAt: lastSuccess } : {}),
    };
  }

  latency(modelId: string): number | undefined {
    return this.#latency.get(modelId);
  }

  recentRequests(modelId: string): number {
    return this.snapshot(modelId).recentRequests;
  }

  inFlight(modelId: string): number {
    return this.#inFlight.get(modelId) ?? 0;
  }

  reset(): void {
    this.#latency.clear();
    this.#peak.clear();
    this.#requests.clear();
    this.#inFlight.clear();
    this.#lastSuccess.clear();
  }
}

/** Estimated price in micro-dollars for a request (input estimate + output cap). */
export function estimateMicroUsd(
  model: ModelConfig,
  inputTokens: number,
  outputTokens: number,
): number {
  const perM = (value: string | undefined) => (value ? Number(value) : 0);
  const input = (inputTokens / 1_000_000) * perM(model.pricing.inputPerMTok);
  const output = (outputTokens / 1_000_000) * perM(model.pricing.outputPerMTok);
  return Math.round((input + output) * 1_000_000);
}

/** Remaining context capacity after the request (negative means it does not fit). */
export function headroom(model: ModelConfig, neededTokens: number): number {
  if (model.contextWindow === undefined) return Number.MAX_SAFE_INTEGER;
  return model.contextWindow - neededTokens;
}
