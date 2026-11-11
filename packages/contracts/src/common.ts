import { z } from 'zod';

/** An arbitrary JSON object (e.g. the JSON Schema of tool parameters). */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** ULID identifier (26 characters, Crockford base32). */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ULID');

/** ISO-8601 timestamp with time zone. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Short, safe identifier for names, aliases, and slugs. */
export const Slug = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/, 'invalid slug');

export const NonNegativeInt = z.int().nonnegative();

/**
 * Dollar amount as a decimal string with at most 8 decimal places (equivalent to Decimal(18,8)).
 * Money is never a float; calculations use `@dirouter/shared` (BigInt fixed-point).
 */
export const UsdAmount = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,8})?$/, 'USD amount must be a decimal string with ≤ 8 decimals');
