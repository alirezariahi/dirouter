/**
 * Key hashing with HMAC-SHA256. The raw virtual key is never stored; only
 * its HMAC with a server-side pepper is kept.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time comparison of two hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** Hash of a virtual key for storage and lookup. */
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
