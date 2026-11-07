/**
 * تولید شناسهٔ ULID (۴۸ بیت زمان + ۸۰ بیت تصادفی، Crockford base32).
 * شناسه‌ها بر اساس زمان مرتب‌پذیرند و برای کلید پارتیشن و ایندکس مناسب‌اند.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_TIME) {
    throw new RangeError(`ULID time out of range: ${ms}`);
  }
  let out = '';
  let rest = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function encodeRandom(): string {
  // ۱۶ کاراکتر × ۵ بیت = ۸۰ بیت. از ۵ بیت پایین هر بایت استفاده می‌شود؛ ۲۵۶ بر ۳۲
  // بخش‌پذیر است پس توزیع یکنواخت می‌ماند.
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte & 31);
  return out;
}

/** یک ULID جدید. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** زمان (میلی‌ثانیه) ذخیره‌شده در یک ULID. */
export function ulidTime(id: string): number {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new TypeError(`invalid ULID: ${id}`);
  let ms = 0;
  for (const char of id.slice(0, TIME_LEN)) ms = ms * 32 + ALPHABET.indexOf(char);
  return ms;
}

/** شناسهٔ پیشونددار مثل `req_01JC…` برای خوانایی در لاگ‌ها. */
export function prefixedId(prefix: string, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}
