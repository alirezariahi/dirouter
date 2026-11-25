/**
 * Short-lived Realtime client secrets for browsers (card 30.5).
 *
 * A server holding a virtual key asks for a secret (`POST /v1/realtime/client_secrets`, or the beta
 * `POST /v1/realtime/sessions`) and hands it to a browser, which opens the WebSocket with it (the
 * `openai-insecure-api-key.<secret>` subprotocol). The secret is stateless: the key ID, the
 * model, an expiry and the session configuration, signed with HMAC-SHA256 under a key derived from
 * KEY_PEPPER, so every replica accepts it and no store is needed. It never contains the virtual
 * key. It only opens a session (it is useless on any other endpoint), only before it expires,
 * and only while its key is still enabled. Like OpenAI's ephemeral keys it starts with `ek_`, so
 * the official SDK allows it in a browser.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CLIENT_SECRET_PREFIX = 'ek_dr_';
/** OpenAI's bounds for `expires_after.seconds`; the beta endpoint always uses one minute. */
export const MIN_SECRET_TTL_SECONDS = 10;
export const MAX_SECRET_TTL_SECONDS = 7_200;
export const DEFAULT_SECRET_TTL_SECONDS = 600;
/** The session configuration travels inside the secret, so it is kept small. */
export const MAX_SECRET_SESSION_BYTES = 8_192;

export interface ClientSecretClaims {
  /** Virtual key ID. */
  keyId: string;
  organizationId: string;
  /** DiRouter model name the session is bound to, when the request named one. */
  model?: string;
  /** Unix seconds. */
  expiresAt: number;
  /** Session configuration applied with `session.update` once the session opens. */
  session?: Record<string, unknown>;
  /** The secret came from the beta endpoint: the session speaks the beta protocol. */
  beta?: boolean;
}

const signingKey = (pepper: string) =>
  createHash('sha256').update(`dirouter-realtime-client-secret:${pepper}`).digest();

const sign = (payload: string, pepper: string) =>
  createHmac('sha256', signingKey(pepper)).update(payload).digest('base64url');

export function issueClientSecret(claims: ClientSecretClaims, pepper: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: claims.keyId,
      o: claims.organizationId,
      e: claims.expiresAt,
      ...(claims.model ? { m: claims.model } : {}),
      ...(claims.session ? { s: claims.session } : {}),
      ...(claims.beta ? { b: 1 } : {}),
    }),
  ).toString('base64url');
  return `${CLIENT_SECRET_PREFIX}${payload}.${sign(payload, pepper)}`;
}

export function isClientSecret(value: string): boolean {
  return value.startsWith(CLIENT_SECRET_PREFIX);
}

/** The claims of a valid, unexpired secret; undefined for anything else. */
export function verifyClientSecret(
  value: string,
  pepper: string,
  now = Date.now(),
): ClientSecretClaims | undefined {
  if (!isClientSecret(value)) return undefined;
  const [payload = '', signature = ''] = value.slice(CLIENT_SECRET_PREFIX.length).split('.');
  const expected = Buffer.from(sign(payload, pepper));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (raw.v !== 1 || typeof raw.k !== 'string' || typeof raw.o !== 'string') return undefined;
  if (typeof raw.e !== 'number' || raw.e * 1000 <= now) return undefined;
  return {
    keyId: raw.k,
    organizationId: raw.o,
    expiresAt: raw.e,
    ...(typeof raw.m === 'string' ? { model: raw.m } : {}),
    ...(raw.s && typeof raw.s === 'object' ? { session: raw.s as Record<string, unknown> } : {}),
    ...(raw.b === 1 ? { beta: true } : {}),
  };
}
