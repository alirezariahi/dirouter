/**
 * Fake OAuth token endpoints (card 27.4), so service-account and Entra ID credentials can be tested
 * without Google or Microsoft:
 *
 * - `POST /oauth2/token`: Google's JWT-bearer grant. The assertion must be a well-formed RS256 JWT
 *   with iss, scope, aud, iat and exp (at most one hour); the signature is not checked because the
 *   mock does not know the public key.
 * - `POST /{tenant}/oauth2/v2.0/token`: Entra ID v2 client-credentials grant.
 *
 * An identity (the JWT `iss` or the `client_id`) that contains `fail` is refused with
 * `invalid_client`, so one credential can fail while another works. Issued tokens look like
 * `mock-oauth-…`; a request that presents such a token after it expired (or one the mock never
 * issued) gets a 401, which proves the gateway refreshes before expiry.
 *
 * `PUT /__mock/oauth {"ttlSeconds":n}` sets the lifetime of new tokens (default 3600);
 * `GET /__mock/oauth` reports issued tokens per identity.
 */
import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';

interface OAuthState {
  ttlSeconds: number;
  issued: Map<string, number>;
  byIdentity: Record<string, number>;
  refused: number;
}

const freshState = (): OAuthState => ({
  ttlSeconds: 3600,
  issued: new Map(),
  byIdentity: {},
  refused: 0,
});

const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply.status(status).send({ error, error_description: description });

function decodeJwt(
  assertion: string,
): { header: Record<string, unknown>; claims: Record<string, unknown> } | undefined {
  const parts = assertion.split('.');
  if (parts.length !== 3 || !parts[2]) return undefined;
  try {
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    return { header: decode(parts[0] ?? ''), claims: decode(parts[1] ?? '') };
  } catch {
    return undefined;
  }
}

export function registerOAuth(app: FastifyInstance): void {
  let state = freshState();

  // Same form parser as the payment mocks; whichever registers first wins.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded'))
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

  const issue = (identity: string, kind: string) => {
    const now = Date.now();
    for (const [old, expiresAt] of state.issued)
      if (expiresAt <= now - 3_600_000) state.issued.delete(old);
    const token = `mock-oauth-${kind}-${randomBytes(9).toString('base64url')}`;
    state.issued.set(token, Date.now() + state.ttlSeconds * 1000);
    state.byIdentity[identity] = (state.byIdentity[identity] ?? 0) + 1;
    return token;
  };

  // A mock-issued bearer token must still be valid on every model call.
  app.addHook('onRequest', (req, reply, done) => {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer mock-oauth-')) {
      const expiresAt = state.issued.get(auth.slice('Bearer '.length));
      if (expiresAt === undefined || expiresAt <= Date.now()) {
        state.refused++;
        void reply.status(401).send({
          error: {
            code: 401,
            message: 'access token expired or unknown',
            status: 'UNAUTHENTICATED',
          },
        });
        return;
      }
    }
    done();
  });

  app.post<{ Body: Record<string, string> | undefined }>('/oauth2/token', (req, reply) => {
    const body = req.body ?? {};
    if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer')
      return oauthError(reply, 400, 'unsupported_grant_type', 'expected the jwt-bearer grant');
    const jwt = decodeJwt(body.assertion ?? '');
    if (!jwt) return oauthError(reply, 400, 'invalid_grant', 'assertion is not a JWT');
    const { header, claims } = jwt;
    const iat = Number(claims.iat);
    const exp = Number(claims.exp);
    if (
      header.alg !== 'RS256' ||
      typeof claims.iss !== 'string' ||
      typeof claims.scope !== 'string' ||
      typeof claims.aud !== 'string' ||
      !claims.aud.endsWith('/oauth2/token') ||
      !Number.isFinite(iat) ||
      !Number.isFinite(exp) ||
      exp <= iat ||
      exp - iat > 3600
    )
      return oauthError(reply, 400, 'invalid_grant', 'invalid JWT header or claims');
    if (claims.iss.includes('fail'))
      return oauthError(reply, 401, 'invalid_client', 'service account is disabled');
    return {
      access_token: issue(claims.iss, 'google'),
      expires_in: state.ttlSeconds,
      token_type: 'Bearer',
    };
  });

  app.post<{ Params: { tenant: string }; Body: Record<string, string> | undefined }>(
    '/:tenant/oauth2/v2.0/token',
    (req, reply) => {
      const body = req.body ?? {};
      if (body.grant_type !== 'client_credentials')
        return oauthError(reply, 400, 'unsupported_grant_type', 'expected client_credentials');
      if (!body.client_id || !body.client_secret || !body.scope?.endsWith('/.default'))
        return oauthError(reply, 400, 'invalid_request', 'client_id, client_secret and scope');
      if (body.client_id.includes('fail'))
        return oauthError(reply, 401, 'invalid_client', 'AADSTS7000215: invalid client secret');
      return {
        token_type: 'Bearer',
        expires_in: state.ttlSeconds,
        ext_expires_in: state.ttlSeconds,
        access_token: issue(`${req.params.tenant}/${body.client_id}`, 'entra'),
      };
    },
  );

  app.get('/__mock/oauth', () => ({
    ttlSeconds: state.ttlSeconds,
    issued: state.issued.size,
    byIdentity: state.byIdentity,
    refused: state.refused,
  }));
  app.put<{ Body: { ttlSeconds?: number; reset?: boolean } | undefined }>(
    '/__mock/oauth',
    (req) => {
      if (req.body?.reset) state = freshState();
      const ttl = Number(req.body?.ttlSeconds);
      if (Number.isInteger(ttl) && ttl > 0) state.ttlSeconds = ttl;
      return { ok: true, ttlSeconds: state.ttlSeconds };
    },
  );
}
