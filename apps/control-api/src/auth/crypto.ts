/**
 * Passwords (argon2id) and tokens (card 3.4).
 *
 * - Password: argon2id with OWASP 2024 parameters (m=19MiB, t=2, p=1).
 * - access token: short-lived JWT HS256 (15 minutes) signed with `JWT_SECRET`.
 * - refresh token: 32 random bytes; only its HMAC-SHA256 is stored in the DB.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';
import { prefixedId } from '@dirouter/shared';
import { jwtVerify, SignJWT } from 'jose';

import type { AuthMethod } from '../rbac/permissions.js';

// The default algorithm of @node-rs/argon2 is Argon2id (the test checks the `$argon2id$` prefix).
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

/** Fixed hash for when the user does not exist: response timing does not reveal a valid username. */
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

export type { AuthMethod };
const AUTH_METHODS: readonly string[] = ['pwd', 'passkey', 'sso'];

export interface AccessClaims {
  sub: string;
  email: string;
  /** Absent means a password session, the least trusted method. */
  amr?: AuthMethod | undefined;
  /** SSO sessions only: the organization whose identity provider vouched for the user. */
  org?: string | undefined;
}

/** How a session (a refresh-token family) was opened. */
export interface SessionOrigin {
  amr: AuthMethod;
  org?: string | undefined;
}

/**
 * The origin of a session is encoded in its family id, which every refresh token of the session
 * carries: it survives rotation without an extra column and cannot be lost like a cache entry.
 * Ids of any other shape (including all families created before this encoding) are password sessions.
 */
export function newFamilyId(origin: SessionOrigin): string {
  if (origin.amr === 'passkey') return prefixedId('fampk');
  if (origin.amr === 'sso' && origin.org) return `${prefixedId('famsso')}_${origin.org}`;
  return prefixedId('fam');
}

export function familyOrigin(familyId: string): SessionOrigin {
  if (familyId.startsWith('fampk_')) return { amr: 'passkey' };
  const sso = /^famsso_[^_]+_(.+)$/.exec(familyId);
  if (sso?.[1]) return { amr: 'sso', org: sso[1] };
  return { amr: 'pwd' };
}

export class TokenService {
  readonly #key: Uint8Array;
  constructor(secret: string) {
    this.#key = new TextEncoder().encode(secret);
  }

  signAccess(claims: AccessClaims, now = Date.now()): Promise<string> {
    return new SignJWT({
      email: claims.email,
      typ: 'access',
      amr: claims.amr ?? 'pwd',
      ...(claims.org ? { org: claims.org } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuer('dirouter')
      .setAudience('dirouter-dashboard')
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + ACCESS_TTL_SECONDS)
      .sign(this.#key);
  }

  /** undefined means the token is invalid or expired; the exact reason is intentionally not disclosed to the client. */
  async verifyAccess(token: string): Promise<AccessClaims | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: ['HS256'],
        issuer: 'dirouter',
        audience: 'dirouter-dashboard',
      });
      if (payload.typ !== 'access' || typeof payload.sub !== 'string') return undefined;
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : '',
        amr:
          typeof payload.amr === 'string' && AUTH_METHODS.includes(payload.amr)
            ? (payload.amr as AuthMethod)
            : 'pwd',
        ...(typeof payload.org === 'string' ? { org: payload.org } : {}),
      };
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
