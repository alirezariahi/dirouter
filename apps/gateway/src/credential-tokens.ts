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
 */
import type { CredentialConfig, ProviderConfig } from '@dirouter/contracts';
import {
  type ClassifiedError,
  TokenCache,
  TokenExchangeError,
  oauthTokenPlan,
  parseTokenResponse,
} from '@dirouter/providers';

import { callUpstream, readErrorBody } from './upstream.js';

/** Process-wide cache shared by chat, embeddings, media, moderation and connection tests. */
export const credentialTokens = new TokenCache();

const TOKEN_TIMEOUTS = { connectMs: 5_000, firstByteMs: 15_000, idleMs: 15_000, totalMs: 20_000 };

/**
 * The key to hand to the adapter: the decrypted secret itself, or an access token obtained with it.
 * Throws a TokenExchangeError when the exchange fails.
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
  return cache.get(plan.cacheKey, async () => {
    const started = Date.now();
    const call = await callUpstream(
      provider,
      plan.build(started),
      TOKEN_TIMEOUTS,
      options.signal,
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
  });
}

/** The attempt result for a failed exchange: cool down this credential, fall back to the next. */
export function tokenFailure(error: unknown): ClassifiedError {
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
