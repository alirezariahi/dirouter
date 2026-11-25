/**
 * Canary and percentage traffic splits (card 32.3).
 *
 * - The branch is chosen from a stable hash of (split id, identity) into 10,000 buckets: a key or
 *   a session keeps its branch while the percentage stays the same, and raising the percentage only
 *   moves stable identities to the canary (never back and forth).
 * - `SplitHealth` lives across snapshots and watches the canary's error rate per split version in
 *   a rolling window; crossing the threshold rolls that version back on this replica at once and
 *   reports it so the other replicas and the control plane follow.
 */
import type { TrafficSplitConfig } from '@dirouter/contracts';

export type SplitBranch = 'stable' | 'canary';
export const SPLIT_BUCKETS = 10_000;

/** FNV-1a over UTF-16 code units, finished with the murmur3 avalanche so nearby ids spread out. */
export function splitBucket(splitId: string, identity: string): number {
  let h = 0x811c9dc5;
  const text = `${splitId}\u0000${identity}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % SPLIT_BUCKETS;
}

/** The branch for an identity; `undefined` identity (stickiness `request`) draws at random. */
export function chooseBranch(
  split: Pick<TrafficSplitConfig, 'id' | 'canaryPercent'>,
  identity: string | undefined,
  random: () => number = Math.random,
): SplitBranch {
  const threshold = Math.round(split.canaryPercent * (SPLIT_BUCKETS / 100));
  const bucket =
    identity === undefined ? Math.floor(random() * SPLIT_BUCKETS) : splitBucket(split.id, identity);
  return bucket < threshold ? 'canary' : 'stable';
}

/** Splits of a snapshot, by organization and the name they match. */
export class SplitIndex {
  readonly #byName = new Map<string, TrafficSplitConfig>();

  constructor(splits: readonly TrafficSplitConfig[]) {
    for (const s of splits)
      if (s.enabled) this.#byName.set(`${s.organizationId}\u0000${s.match}`, s);
  }

  get size(): number {
    return this.#byName.size;
  }

  find(organizationId: string, name: string): TrafficSplitConfig | undefined {
    if (this.#byName.size === 0) return undefined;
    return this.#byName.get(`${organizationId}\u0000${name}`);
  }
}

interface Window {
  /** Requests and errors per second, in a ring of `windowSeconds` slots. */
  seconds: Int32Array;
  total: Int32Array;
  errors: Int32Array;
  rolledBack: boolean;
}

export interface SplitTrip {
  split: TrafficSplitConfig;
  errorRate: number;
  requests: number;
}

export class SplitHealth {
  readonly #windows = new Map<string, Window>();
  readonly #now: () => number;
  readonly #onTrip: ((trip: SplitTrip) => void) | undefined;

  constructor(options: { now?: () => number; onTrip?: (trip: SplitTrip) => void } = {}) {
    this.#now = options.now ?? Date.now;
    this.#onTrip = options.onTrip;
  }

  #key(split: Pick<TrafficSplitConfig, 'id' | 'version'>) {
    return `${split.id}:${String(split.version)}`;
  }

  /** Whether this version was rolled back here or reported rolled back by another replica. */
  rolledBack(split: Pick<TrafficSplitConfig, 'id' | 'version'>): boolean {
    return this.#windows.get(this.#key(split))?.rolledBack === true;
  }

  /** Marks a version rolled back (another replica or the control plane said so). */
  markRolledBack(split: Pick<TrafficSplitConfig, 'id' | 'version'>): void {
    const key = this.#key(split);
    const w = this.#windows.get(key) ?? this.#create(60);
    w.rolledBack = true;
    this.#windows.set(key, w);
  }

  #create(size: number): Window {
    return {
      seconds: new Int32Array(size).fill(-1),
      total: new Int32Array(size),
      errors: new Int32Array(size),
      rolledBack: false,
    };
  }

  /**
   * Records the outcome of a request on the canary branch; returns true when this outcome rolled
   * the version back. Stable-branch outcomes are not recorded: the decision is about the canary.
   */
  record(split: TrafficSplitConfig, ok: boolean): boolean {
    const rollback = split.autoRollback;
    if (!rollback?.enabled || split.state !== 'active') return false;
    const key = this.#key(split);
    let w = this.#windows.get(key);
    if (!w || w.seconds.length !== rollback.windowSeconds) {
      w = this.#create(rollback.windowSeconds);
      this.#windows.set(key, w);
      // Versions are short-lived: forget the oldest when many accumulate.
      if (this.#windows.size > 1_000) {
        const first = this.#windows.keys().next().value;
        if (first !== undefined) this.#windows.delete(first);
      }
    }
    if (w.rolledBack) return false;
    const second = Math.floor(this.#now() / 1_000);
    const slot = second % w.seconds.length;
    if (w.seconds[slot] !== second) {
      w.seconds[slot] = second;
      w.total[slot] = 0;
      w.errors[slot] = 0;
    }
    w.total[slot] = (w.total[slot] ?? 0) + 1;
    if (!ok) w.errors[slot] = (w.errors[slot] ?? 0) + 1;
    let total = 0;
    let errors = 0;
    for (let i = 0; i < w.seconds.length; i++) {
      const at = w.seconds[i] ?? -1;
      if (at < 0 || second - at >= w.seconds.length) continue;
      total += w.total[i] ?? 0;
      errors += w.errors[i] ?? 0;
    }
    if (total < rollback.minRequests || errors / total < rollback.errorRate) return false;
    w.rolledBack = true;
    this.#onTrip?.({ split, errorRate: errors / total, requests: total });
    return true;
  }
}

export interface SplitDecision {
  split: TrafficSplitConfig;
  branch: SplitBranch;
  target: string;
}

/**
 * The split stage: when the organization splits this name, the branch and its target. A
 * rolled-back version (in the snapshot or on this replica) always goes to `stable`.
 */
export function applySplit(
  index: SplitIndex,
  health: SplitHealth,
  organizationId: string,
  name: string,
  identity: { key: string; session?: string | undefined },
  random?: () => number,
): SplitDecision | undefined {
  const split = index.find(organizationId, name);
  if (!split) return undefined;
  const branch: SplitBranch =
    split.state === 'rolled_back' || health.rolledBack(split)
      ? 'stable'
      : chooseBranch(
          split,
          split.stickiness === 'request'
            ? undefined
            : split.stickiness === 'session'
              ? (identity.session ?? identity.key)
              : identity.key,
          random,
        );
  return { split, branch, target: branch === 'canary' ? split.canary : split.stable };
}
