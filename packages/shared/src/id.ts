/**
 * ULID generation (48 bits of time + 80 random bits, Crockford base32).
 * IDs are sortable by time and suit partition keys and indexes.
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
  // 32 characters × 5 bits = 80 bits. The low 5 bits of each byte are used; 256 divided by 32
  // is exact, so the distribution stays uniform.
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (const byte of bytes) out += ALPHABET.charAt(byte & 31);
  return out;
}

/** A new ULID. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Time (milliseconds) stored in a ULID. */
export function ulidTime(id: string): number {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new TypeError(`invalid ULID: ${id}`);
  let ms = 0;
  for (const char of id.slice(0, TIME_LEN)) ms = ms * 32 + ALPHABET.indexOf(char);
  return ms;
}

/** Prefixed ID such as `req_01JC…` for readability in logs. */
export function prefixedId(prefix: string, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}
