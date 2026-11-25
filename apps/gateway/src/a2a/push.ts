/**
 * A2A push notifications (card 28.2): webhook configurations of a task, their validation (SSRF),
 * and signed delivery.
 *
 * Every notification is a POST of one A2A payload (v1.0: a `StreamResponse`; v0.3: the `Task`)
 * carrying, besides what the configuration asks for (`Authorization: <scheme> <credentials>`,
 * `X-A2A-Notification-Token`), a signature the receiver can check without sharing a secret:
 * `X-DiRouter-Push-Signature` is a compact JWS (ES256) whose claims bind the exact body
 * (`request_body_sha256`), the webhook (`aud`), the task and the time (`iat`, `exp`, `jti`). The
 * public key is published at `/.well-known/jwks.json` (also named by the `jku` header). The key is
 * derived from MASTER_KEY, so every replica signs with the same key and rotating MASTER_KEY rotates
 * it (new `kid`).
 */
import {
  createECDH,
  createHash,
  createPrivateKey,
  hkdfSync,
  type KeyObject,
  randomUUID,
  sign,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { isBlockedAddress, type Keyring } from '@dirouter/shared';

import { A2aError, type Version } from './common.js';

/** A webhook registered for a task (stored encrypted with the task). */
export interface PushConfig {
  id: string;
  url: string;
  token?: string;
  authentication?: { scheme: string; credentials?: string };
  /** Wire format of the client that registered it. */
  version: Version;
}

export const MAX_PUSH_CONFIGS = 10;

// P-256 group order.
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

/** ES256 signer with a key derived from the current MASTER_KEY. */
export class PushSigner {
  readonly jwk: PublicJwk;
  readonly #key: KeyObject;

  constructor(keyring: Keyring) {
    const master = keyring.keys.get(keyring.currentVersion);
    if (!master) throw new Error('keyring has no current key');
    const seed = Buffer.from(hkdfSync('sha256', master, 'dirouter', 'a2a-push-signing-v1', 48));
    // Reduce into [1, n-1] (48 bytes keep the bias negligible).
    const d = (BigInt(`0x${seed.toString('hex')}`) % (P256_N - 1n)) + 1n;
    const dBytes = Buffer.from(d.toString(16).padStart(64, '0'), 'hex');
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(dBytes);
    const point = ecdh.getPublicKey();
    const x = b64url(point.subarray(1, 33));
    const y = b64url(point.subarray(33, 65));
    this.#key = createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: b64url(dBytes), x, y },
      format: 'jwk',
    });
    // RFC 7638 thumbprint as the key id.
    const kid = createHash('sha256')
      .update(JSON.stringify({ crv: 'P-256', kty: 'EC', x, y }))
      .digest('base64url');
    this.jwk = { kty: 'EC', crv: 'P-256', x, y, kid, alg: 'ES256', use: 'sig' };
  }

  /** Compact JWS over the claims (the body itself is bound by its SHA-256). */
  sign(body: string, claims: { iss: string; aud: string; taskId: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'ES256',
      typ: 'JWT',
      kid: this.jwk.kid,
      jku: `${claims.iss}/.well-known/jwks.json`,
    };
    const payload = {
      ...claims,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      request_body_sha256: createHash('sha256').update(body).digest('hex'),
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = sign('sha256', Buffer.from(input), {
      key: this.#key,
      dsaEncoding: 'ieee-p1363',
    });
    return `${input}.${b64url(signature)}`;
  }
}

/**
 * The webhook URL a tenant gave: http(s) only, no credentials in it, and with the SSRF guard on
 * (production, customer organizations) https to public addresses only. Checked again when
 * connecting, against DNS rebinding.
 */
export async function checkWebhookUrl(raw: string, guarded: boolean): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new A2aError(-32602, 'push notification url is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new A2aError(-32602, 'push notification url must be http or https');
  if (url.username || url.password)
    throw new A2aError(-32602, 'push notification url must not carry credentials');
  if (!guarded) return url.toString();
  if (url.protocol !== 'https:') throw new A2aError(-32602, 'push notification url must be https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses =
      isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a)))
    throw new A2aError(-32602, 'push notification url must resolve to a public address');
  return url.toString();
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * A configuration from either wire format. v1.0 sends it flat (`{taskId, id?, url, token?,
 * authentication: {scheme, credentials?}}`); v0.3 nests it (`{taskId, pushNotificationConfig: {id?,
 * url, token?, authentication: {schemes: [...], credentials?}}}`). Nested v1.0 drafts are accepted.
 */
export function readPushConfig(
  raw: unknown,
  version: Version,
): { taskId?: string; config: Omit<PushConfig, 'id'> & { id?: string } } {
  const outer = (raw ?? {}) as Record<string, unknown>;
  const inner = (outer.pushNotificationConfig ?? outer.config ?? outer) as Record<string, unknown>;
  const url = str(inner.url);
  if (!url) throw new A2aError(-32602, 'push notification config needs a url');
  const auth = inner.authentication as
    { scheme?: unknown; schemes?: unknown; credentials?: unknown } | undefined;
  const scheme =
    str(auth?.scheme) ??
    (Array.isArray(auth?.schemes) ? str((auth.schemes as unknown[])[0]) : undefined);
  const id = str(inner.id) ?? str(outer.id);
  const token = str(inner.token);
  const credentials = str(auth?.credentials);
  if (scheme && !/^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]*$/.test(scheme))
    throw new A2aError(-32602, 'authentication scheme is not a valid HTTP auth scheme');
  if ((credentials ?? '').length > 4096 || (token ?? '').length > 4096 || url.length > 2000)
    throw new A2aError(-32602, 'push notification config is too large');
  return {
    ...(str(outer.taskId) ? { taskId: str(outer.taskId) } : {}),
    config: {
      ...(id ? { id } : {}),
      url,
      ...(token ? { token } : {}),
      ...(scheme ? { authentication: { scheme, ...(credentials ? { credentials } : {}) } } : {}),
      version,
    },
  };
}

/** A configuration as the client sees it; credentials are never returned. */
export function pushConfigView(taskId: string, config: PushConfig, version: Version) {
  if (version === '1.0')
    return {
      taskId,
      id: config.id,
      url: config.url,
      ...(config.token ? { token: config.token } : {}),
      ...(config.authentication
        ? { authentication: { scheme: config.authentication.scheme } }
        : {}),
    };
  return {
    taskId,
    pushNotificationConfig: {
      id: config.id,
      url: config.url,
      ...(config.token ? { token: config.token } : {}),
      ...(config.authentication
        ? { authentication: { schemes: [config.authentication.scheme] } }
        : {}),
    },
  };
}

export interface Delivery {
  config: PushConfig;
  body: string;
  taskId: string;
  issuer: string;
}

/**
 * POSTs one notification: at least once, retried on network errors, 429 and 5xx with backoff
 * (0.5 s, 1 s, 2 s), 10 seconds per attempt, redirects never followed.
 */
export async function deliverPush(
  delivery: Delivery,
  signer: PushSigner,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  delaysMs: readonly number[] = [500, 1000, 2000],
): Promise<{ ok: boolean; status?: number; error?: string; attempts: number }> {
  const { config, body } = delivery;
  const headers: Record<string, string> = {
    'content-type': config.version === '1.0' ? 'application/a2a+json' : 'application/json',
    'a2a-version': config.version,
    'user-agent': 'DiRouter-A2A-Push/1.0',
    'x-dirouter-push-signature': signer.sign(body, {
      iss: delivery.issuer,
      aud: config.url,
      taskId: delivery.taskId,
    }),
    ...(config.token ? { 'x-a2a-notification-token': config.token } : {}),
    ...(config.authentication?.credentials
      ? { authorization: `${config.authentication.scheme} ${config.authentication.credentials}` }
      : {}),
  };
  let last: { status?: number; error?: string } = {};
  let attempts = 0;
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    attempts = attempt + 1;
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]));
    try {
      const res = await fetchImpl(config.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300)
        return { ok: true, status: res.status, attempts: attempt + 1 };
      last = { status: res.status };
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      last = {
        error:
          error instanceof Error
            ? error.cause instanceof Error
              ? error.cause.message
              : error.message
            : String(error),
      };
    }
  }
  return { ok: false, ...last, attempts };
}
