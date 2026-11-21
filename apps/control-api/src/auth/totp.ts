/**
 * TOTP (RFC 6238) with SHA-1/30s/6 digits, as every authenticator app expects (card 14.1), plus
 * backup codes. Only node:crypto is used; the shared secret is stored encrypted with the MASTER_KEY
 * keyring.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = (digest.at(-1) ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const totpStepAt = (atMs: number): number => Math.floor(atMs / 1000 / STEP_SECONDS);

/**
 * The time step whose code equals `code`, or undefined when none in the window matches. The
 * previous/next step is accepted so a slightly skewed clock still works.
 */
export function matchTotpStep(
  secret: string,
  code: string,
  atMs = Date.now(),
  window = 1,
): number | undefined {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return undefined;
  let matched: number | undefined;
  // Every candidate is compared (no early exit) so timing does not reveal which step matched.
  for (let offset = -window; offset <= window; offset++) {
    const at = atMs + offset * STEP_SECONDS * 1_000;
    const expected = totpCode(secret, at);
    if (
      expected.length === normalized.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))
    )
      matched ??= totpStepAt(at);
  }
  return matched;
}

export function verifyTotp(secret: string, code: string, atMs = Date.now(), window = 1): boolean {
  return matchTotpStep(secret, code, atMs, window) !== undefined;
}

/**
 * Replay rule (RFC 6238 section 5.2): a code is accepted only when its time step is newer than the
 * last accepted one, so an observed code cannot be used a second time.
 */
export function isFreshTotpStep(lastAccepted: number | undefined, step: number): boolean {
  return lastAccepted === undefined || step > lastAccepted;
}

/** Remembers the last accepted step per user; `claim` is atomic and false means a replay. */
export interface TotpStepStore {
  claim(userId: string, step: number): Promise<boolean>;
}

/** Minimal Valkey surface used by `ValkeyTotpStepStore`. */
export interface TotpStepBackend {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Steps older than the verification window can never match again, so a short TTL is enough.
const STEP_TTL_SECONDS = 10 * 60;
const CLAIM_STEP = `local last = tonumber(redis.call('GET', KEYS[1]))
if last and tonumber(ARGV[1]) <= last then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;

export class MemoryTotpStepStore implements TotpStepStore {
  readonly #last = new Map<string, number>();
  claim(userId: string, step: number): Promise<boolean> {
    if (!isFreshTotpStep(this.#last.get(userId), step)) return Promise.resolve(false);
    this.#last.set(userId, step);
    return Promise.resolve(true);
  }
}

/**
 * Valkey-backed store shared by all replicas. When Valkey is unreachable the node's own memory is
 * used, like the login limiter: weaker across replicas, but sign-in keeps working.
 */
export class ValkeyTotpStepStore implements TotpStepStore {
  readonly #fallback = new MemoryTotpStepStore();
  constructor(private readonly backend: TotpStepBackend) {}

  async claim(userId: string, step: number): Promise<boolean> {
    // The fallback is always updated so a replay is still caught if Valkey drops out in between.
    if (!(await this.#fallback.claim(userId, step))) return false;
    try {
      const result = await this.backend.eval(
        CLAIM_STEP,
        1,
        `dirouter:mfa:step:${userId}`,
        step,
        STEP_TTL_SECONDS,
      );
      return result === 1;
    } catch {
      return true;
    }
  }
}

export function otpauthUrl(input: { secret: string; email: string; issuer?: string }): string {
  const issuer = input.issuer ?? 'DiRouter';
  const label = encodeURIComponent(`${issuer}:${input.email}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten single-use backup codes, shown once at enrollment. */
export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

export function hashBackupCode(code: string): string {
  return createHash('sha256')
    .update(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase())
    .digest('hex');
}

export function consumeBackupCode(hashes: string[], code: string): string[] | undefined {
  const hash = hashBackupCode(code);
  const index = hashes.indexOf(hash);
  if (index < 0) return undefined;
  return [...hashes.slice(0, index), ...hashes.slice(index + 1)];
}
