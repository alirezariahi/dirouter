/**
 * رمز عبور (argon2id) و توکن‌ها (کارت ۳.۴).
 *
 * - رمز: argon2id با پارامترهای OWASP 2024 (m=19MiB، t=2، p=1).
 * - access token: JWT HS256 کوتاه‌عمر (۱۵ دقیقه) با `JWT_SECRET`.
 * - refresh token: ۳۲ بایت تصادفی؛ در DB فقط HMAC-SHA256 آن ذخیره می‌شود.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';
import { jwtVerify, SignJWT } from 'jose';

// الگوریتم پیش‌فرض @node-rs/argon2 همان Argon2id است (تست پیشوند `$argon2id$` را چک می‌کند).
const ARGON = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON);
}

/** hash ثابت برای وقتی کاربر وجود ندارد: زمان پاسخ نام کاربری معتبر را لو نمی‌دهد. */
let dummy: Promise<string> | undefined;
export async function verifyPassword(
  stored: string | undefined,
  password: string,
): Promise<boolean> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  try {
    return await verify(stored ?? (await dummy), password);
  } catch {
    return false;
  }
}

export interface AccessClaims {
  sub: string;
  email: string;
}

export class TokenService {
  readonly #key: Uint8Array;
  constructor(secret: string) {
    this.#key = new TextEncoder().encode(secret);
  }

  signAccess(claims: AccessClaims, now = Date.now()): Promise<string> {
    return new SignJWT({ email: claims.email, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer('dirouter')
      .setAudience('dirouter-dashboard')
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + ACCESS_TTL_SECONDS)
      .sign(this.#key);
  }

  /** undefined یعنی توکن نامعتبر یا منقضی؛ دلیل دقیق عمداً به کلاینت گفته نمی‌شود. */
  async verifyAccess(token: string): Promise<AccessClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: ['HS256'],
        issuer: 'dirouter',
        audience: 'dirouter-dashboard',
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string') return undefined;
      return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
    } catch {
      return undefined;
    }
  }

  newRefreshToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefresh(token) };
  }

  hashRefresh(token: string): string {
    return createHmac('sha256', this.#key).update(`refresh:${token}`).digest('hex');
  }
}
