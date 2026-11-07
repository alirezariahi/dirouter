/**
 * هش کلیدها با HMAC-SHA256. کلید مجازی خام هرگز ذخیره نمی‌شود؛ فقط
 * HMAC آن با یک pepper سمت سرور نگه داشته می‌شود.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** مقایسهٔ زمان‌ثابت دو رشتهٔ hex. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** هش یک کلید مجازی برای ذخیره و جستجو. */
export function hashApiKey(apiKey: string, pepper: string | Buffer): string {
  return hmacSha256Hex(pepper, apiKey);
}

export function verifyApiKey(
  apiKey: string,
  pepper: string | Buffer,
  expectedHash: string,
): boolean {
  return timingSafeEqualHex(hashApiKey(apiKey, pepper), expectedHash);
}
