/**
 * OAuth access tokens for credentials (card 27.4): a Vertex service-account key or Azure Entra ID
 * client credentials are exchanged for a short-lived access token before the upstream request is
 * built. Tokens are cached per credential (and per secret, so a rotated key gets a new token) and
 * refreshed before they expire. The token call goes through `callUpstream`, so the credential or
 * provider proxy, timeouts and the SSRF guard apply exactly as for the model call.
 *
 * A failed exchange is a fault of that one credential: the attempt fails with
 * `credentialAction: 'cooldown'`, so the health registry cools down only that credential and the
 * provider's breaker is left alone.
 *
 * One exchange is shared by every concurrent request for that credential, so it runs on its own
 * timeout-only signal: a client that disconnects (or a hedged attempt that loses) stops waiting
 * for the token without cancelling the exchange for the others, and its attempt is not reported
 * as a credential failure. A token the upstream rejects with 401/403 is dropped from the cache
 * (see `server.ts`), so a revoked token is not reused until its refresh window.
 */
import type { CredentialConfig, ProviderConfig } from '@dirouter/contracts';
import {
  type ClassifiedError,
  TokenCache,
  TokenExchangeError,
  TokenWaitAborted,
  classified,
  oauthTokenPlan,
  parseTokenResponse,
} from '@dirouter/providers';

import { callUpstream, readErrorBody } from './upstream.js';

/** Process-wide cache shared by chat, embeddings, media, moderation and connection tests. */
export const credentialTokens = new TokenCache();

const TOKEN_TIMEOUTS = { connectMs: 5_000, firstByteMs: 15_000, idleMs: 15_000, totalMs: 20_000 };

/**
 * The key to hand to the adapter: the decrypted secret itself, or an access token obtained with it.
 * Throws a TokenExchangeError when the exchange fails, and a TokenWaitAborted when `signal` aborts
 * first (the shared exchange keeps running for the other callers).
 */
export async function resolveCredentialKey(
  provider: ProviderConfig,
  credential: Pick<CredentialConfig, 'id'>,
  secret: string,
  options: { signal: AbortSignal; proxyUrl?: string | undefined; cache?: TokenCache },
): Promise<string> {
  const plan = oauthTokenPlan(provider, credential.id, secret);
  if (!plan) return secret;
  const cache = options.cache ?? credentialTokens;
  return cache.get(
    plan.cacheKey,
    async () => {
      const started = Date.now();
      // Never a caller's signal: TOKEN_TIMEOUTS bound the shared exchange.
      const call = await callUpstream(
        provider,
        plan.build(started),
        TOKEN_TIMEOUTS,
        new AbortController().signal,
        false,
        options.proxyUrl,
      ).catch((error: unknown) => {
        throw new TokenExchangeError(
          `token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      try {
        const { response } = call;
        const body: unknown = response.ok
          ? await response.json().catch(() => undefined)
          : await readErrorBody(response)
              .then((text) => JSON.parse(text) as unknown)
              .catch(() => undefined);
        return parseTokenResponse(response.status, body, started);
      } finally {
        call.done();
      }
    },
    options.signal,
  );
}

/** The attempt result for a failed exchange: cool down this credential, fall back to the next. */
export function tokenFailure(error: unknown): ClassifiedError {
  // This caller went away (client disconnect, lost hedge): nothing is wrong with the credential.
  if (error instanceof TokenWaitAborted)
    return classified('connection', {
      message: 'request aborted while waiting for the credential token',
    });
  const message = error instanceof Error ? error.message : String(error);
  return {
    class: 'auth',
    retryable: false,
    fallbackAllowed: true,
    credentialAction: 'cooldown',
    message: `credential token refresh failed: ${message}`.slice(0, 300),
    ...(error instanceof TokenExchangeError && error.status !== undefined
      ? { status: error.status }
      : {}),
  };
}
