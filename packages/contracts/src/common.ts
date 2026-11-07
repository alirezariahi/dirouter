import { z } from 'zod';

/** یک شیء JSON دلخواه (مثلاً JSON Schema پارامترهای ابزار). */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** شناسهٔ ULID (۲۶ کاراکتر Crockford base32). */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid ULID');

/** زمان ISO-8601 با منطقهٔ زمانی. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** شناسهٔ کوتاه و امن برای نام‌ها، aliasها و slugها. */
export const Slug = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/, 'invalid slug');

export const NonNegativeInt = z.int().nonnegative();

/**
 * مبلغ دلاری به‌صورت رشتهٔ اعشاری با حداکثر ۸ رقم اعشار (معادل Decimal(18,8)).
 * پول هرگز float نیست؛ محاسبه با `@dirouter/shared` (BigInt fixed-point).
 */
export const UsdAmount = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,8})?$/, 'USD amount must be a decimal string with ≤ 8 decimals');
