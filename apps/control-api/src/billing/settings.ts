/**
 * Operator billing settings (card 19.2, extended by 19.4): stored as one JSON row and read on every
 * use, so a change applies at once without a deploy.
 */
import { z } from 'zod';

const Decimal = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,8})?$/, 'a non-negative decimal with at most 8 decimals');

export const BillingSettings = z.object({
  /** Units of each currency per USD, e.g. `{ "IRR": "1050000" }`. USD is always 1. */
  exchangeRates: z.record(z.string().regex(/^[A-Z]{3}$/), Decimal).default({}),
  topup: z
    .object({ minUsd: Decimal.default('1'), maxUsd: Decimal.default('1000') })
    .default({ minUsd: '1', maxUsd: '1000' }),
  /** Payment providers offered to customers (each also needs its credentials in env). */
  providers: z.array(z.enum(['zarinpal', 'stripe'])).default([]),
  /** Self-service portal (card 19.5). */
  portal: z
    .object({
      /** Anyone may sign up; off by default so an install never opens itself by surprise. */
      signupEnabled: z.boolean().default(false),
      /** Credit given to every new self-service organization (from the promo account). */
      welcomeCreditUsd: Decimal.default('0'),
    })
    .default({ signupEnabled: false, welcomeCreditUsd: '0' }),
  /**
   * Invoice tax (card 26.1). Charges include VAT: each invoice splits what the customer paid for
   * services into net + VAT at this rate, as of the day it is issued. 0 (the default) means no VAT.
   */
  tax: z
    .object({
      vatPercent: z
        .string()
        .trim()
        .regex(/^\d{1,2}(\.\d{1,2})?$/, 'a percentage below 100 with at most 2 decimals')
        .default('0'),
    })
    .default({ vatPercent: '0' }),
});
export type BillingSettings = z.infer<typeof BillingSettings>;
export type BillingSettingsInput = z.input<typeof BillingSettings>;
