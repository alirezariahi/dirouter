/**
 * Circuit breaker state shared between the gateway and the worker (card 24.2).
 *
 * The gateway keeps its breakers in memory and syncs replicas over pub/sub; on every breaker
 * transition it also writes the result into one Valkey hash, so the worker can evaluate
 * `breaker_open` alert rules. Field: `<scope>:<id>`; a closed breaker (or a manual reset) removes
 * its field. Entries carry their write time, so a field left behind by a crashed replica ages out.
 */
import { z } from 'zod';

export const BREAKER_STATE_KEY = 'dirouter:breakers';

export const BreakerStateEntry = z.object({
  state: z.enum(['open', 'half_open']),
  /** Epoch ms of the transition. */
  at: z.number(),
  /** Epoch ms when an open breaker lets probes through again. */
  reopensAt: z.number().optional(),
});
export type BreakerStateEntry = z.infer<typeof BreakerStateEntry>;

export function breakerStateField(scope: 'provider' | 'model', id: string): string {
  return `${scope}:${id}`;
}
