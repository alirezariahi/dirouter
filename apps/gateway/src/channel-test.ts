/**
 * Scheduled channel tests (card 32.9): a small real request per credential, separate from the
 * model-list health probe. A model list answers even when an account has no credit left or a key
 * lost access to a model; a one-token completion on the provider's cheapest chat model does not.
 *
 * Runs on the HealthProber machinery with its own settings (`settings.channelTest`), lock and
 * reason prefix. A credential is taken out of rotation for authentication failures and exhausted
 * credit (`quota`), and restored after it passes again. The test spends a few tokens on the
 * operator's account; it is not a customer request and writes no usage event.
 */
import type {
  CanonicalRequest,
  ConfigSnapshot,
  ModelConfig,
  ProviderConfig,
} from '@dirouter/contracts';
import { ChannelTestSettings } from '@dirouter/contracts';
import { adapterForProvider, classifyNetworkError } from '@dirouter/providers';
import { decrypt, type Keyring, type Logger } from '@dirouter/shared';

import { resolveCredentialKey, tokenFailure } from './credential-tokens.js';
import { CHANNEL_TEST_REASON_PREFIX, HealthProber, type ProbeRedis } from './health-probe.js';
import type { ProbeResult } from './probe.js';
import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';

export const CHANNEL_TEST_LOCK_KEY = 'dirouter:health:channel-test-lock';

const price = (m: ModelConfig) => Number(m.pricing.inputPerMTok) + Number(m.pricing.outputPerMTok);

/** The provider's cheapest enabled chat model (no embedding or media-only models). */
export function testModel(snapshot: ConfigSnapshot, provider: ProviderConfig) {
  return snapshot.models
    .filter((m) => {
      const caps = m.capabilities as Record<string, unknown>;
      return (
        m.providerId === provider.id &&
        m.enabled &&
        caps.embeddings !== true &&
        caps.images !== true &&
        caps.speech !== true &&
        caps.transcription !== true
      );
    })
    .sort((a, b) => price(a) - price(b) || a.slug.localeCompare(b.slug))[0];
}

export async function channelTest(
  provider: ProviderConfig,
  credentialId: string,
  model: ModelConfig,
  keyring: Keyring,
): Promise<ProbeResult> {
  const credential = provider.credentials.find((c) => c.id === credentialId);
  if (!credential)
    return {
      ok: false,
      latencyMs: 0,
      error: { class: 'bad_request', message: 'no credential' },
      models: [],
    };
  const proxyUrl = credential.proxy?.url ?? provider.proxy?.url;
  const started = Date.now();
  let apiKey: string;
  try {
    apiKey = await resolveCredentialKey(
      provider,
      credential,
      decrypt(keyring, credential.secret, credential.id),
      { signal: AbortSignal.timeout(20_000), proxyUrl },
    );
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: { class: 'auth', message: tokenFailure(error).message },
      models: [],
    };
  }
  const request: CanonicalRequest = {
    inboundApi: 'openai.chat',
    model: model.slug,
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    maxOutputTokens: 1,
    stream: false,
  };
  const adapter = adapterForProvider(provider);
  const upstream = adapter.buildRequest({
    provider,
    model,
    apiKey,
    credentialHeaders: credential.headers,
    request,
  });
  const timeouts = mergeTimeouts({ connectMs: 5_000, totalMs: 20_000 }, provider.timeouts);
  try {
    const call = await callUpstream(
      provider,
      upstream,
      timeouts,
      AbortSignal.timeout(25_000),
      false,
      proxyUrl,
    );
    try {
      const latencyMs = Date.now() - started;
      if (call.response.ok) {
        await call.response.arrayBuffer().catch(() => undefined);
        return { ok: true, status: call.response.status, latencyMs, models: [] };
      }
      const classified = adapter.classifyError({
        status: call.response.status,
        headers: call.response.headers,
        body: await readErrorBody(call.response),
      });
      // Exhausted credit (402, or insufficient_quota) is its own class: it disables the key.
      const quota = call.response.status === 402 || classified.credentialAction === 'disable';
      return {
        ok: false,
        status: call.response.status,
        latencyMs,
        error: {
          class: quota && classified.class !== 'auth' ? 'quota' : classified.class,
          message: classified.message.slice(0, 300),
        },
        models: [],
      };
    } finally {
      call.done();
    }
  } catch (error) {
    const classified = classifyNetworkError(error, error instanceof UpstreamTimeout);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: { class: classified.class, message: classified.message.slice(0, 300) },
      models: [],
    };
  }
}

/** The channel tester: HealthProber with the channel-test settings, lock and probe. */
export function createChannelTester(opts: {
  snapshot: () => ConfigSnapshot | undefined;
  health: ConstructorParameters<typeof HealthProber>[0]['health'];
  keyring: Keyring;
  logger: Logger;
  instance: string;
  redis?: ProbeRedis;
  test?: typeof channelTest;
}): HealthProber {
  const run = opts.test ?? channelTest;
  return new HealthProber({
    snapshot: opts.snapshot,
    health: opts.health,
    keyring: opts.keyring,
    logger: opts.logger,
    instance: opts.instance,
    ...(opts.redis ? { redis: opts.redis } : {}),
    settings: (snapshot) => ChannelTestSettings.parse(snapshot?.settings.channelTest ?? {}),
    lockKey: CHANNEL_TEST_LOCK_KEY,
    reasonPrefix: CHANNEL_TEST_REASON_PREFIX,
    disableOn: ['auth', 'quota'],
    eligible: (provider, snapshot) => testModel(snapshot, provider) !== undefined,
    probe: async (provider, credentialId) => {
      const snapshot = opts.snapshot();
      const model = snapshot ? testModel(snapshot, provider) : undefined;
      if (!model)
        return {
          ok: false,
          latencyMs: 0,
          error: { class: 'not_found', message: 'no chat model to test' },
          models: [],
        };
      return run(provider, credentialId, model, opts.keyring);
    },
  });
}
