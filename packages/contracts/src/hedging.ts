/**
 * Hedging configuration shared by routing and the gateway (card 12.2).
 * `maxRatio` bounds the share of traffic that may be hedged in a rolling window.
 */
import { z } from 'zod';

export const HedgingBudgetSchema = z.object({
  maxRatio: z.number().min(0).max(1).default(0.2),
  windowMs: z.int().positive().default(60_000),
});
export type HedgeBudgetOptions = z.infer<typeof HedgingBudgetSchema>;
