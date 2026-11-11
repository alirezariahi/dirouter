/**
 * Connection test and model discovery for control-api (card 3.6). Runs inside the gateway so the same
 * adapter, proxy (credential, provider or global) and real-traffic timeouts are applied.
 * The encrypted secret arrives and is only decrypted in the gateway's memory.
 */
import { ProviderConfig } from '@dirouter/contracts';
import { findByUpstream } from '@dirouter/model-catalog';
import { adapterFor, classifyNetworkError } from '@dirouter/providers';
import { decrypt, type Keyring, ValidationError } from '@dirouter/shared';
import { z } from 'zod';

import { callUpstream, mergeTimeouts, readErrorBody, UpstreamTimeout } from './upstream.js';

export const ProbeRequest = z.object({
  provider: ProviderConfig,
  credentialId: z.string().optional(),
  proxyUrl: z.string().optional(),
});

export interface ProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: { class: string; message: string };
  models: { id: string; catalog?: { key: string; contextWindow?: number; pricing: unknown } }[];
}

export async function probeProvider(body: unknown, keyring: Keyring): Promise<ProbeResult> {
  const parsed = ProbeRequest.safeParse(body);
  if (!parsed.success)
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  const { provider, credentialId } = parsed.data;
  const credential = credentialId
    ? provider.credentials.find((c) => c.id === credentialId)
    : provider.credentials.find((c) => c.enabled);
  const secret = credential ? decrypt(keyring, credential.secret, credential.id) : '';
  const adapter = adapterFor(provider.type);
  const req = adapter.listModelsRequest(provider, secret);
  const proxyUrl = credential?.proxy?.url ?? provider.proxy?.url ?? parsed.data.proxyUrl;
  const timeouts = mergeTimeouts(
    { connectMs: 5_000, firstByteMs: 15_000, idleMs: 15_000, totalMs: 20_000 },
    provider.timeouts,
  );
  const started = Date.now();
  try {
    const call = await callUpstream(
      provider,
      { ...req, method: 'GET' },
      timeouts,
      new AbortController().signal,
      false,
      proxyUrl,
    );
    try {
      const latencyMs = Date.now() - started;
      if (!call.response.ok) {
        const classified = adapter.classifyError({
          status: call.response.status,
          headers: call.response.headers,
          body: await readErrorBody(call.response),
        });
        return {
          ok: false,
          status: call.response.status,
          latencyMs,
          error: { class: classified.class, message: classified.message.slice(0, 300) },
          models: [],
        };
      }
      const ids = adapter.parseModelList(await call.response.json());
      // Catalog name: a preset (e.g. groq) or the provider type itself.
      const catalogProvider =
        typeof provider.options.preset === 'string'
          ? provider.options.preset
          : provider.type === 'azure-openai'
            ? 'openai'
            : provider.type;
      return {
        ok: true,
        status: call.response.status,
        latencyMs,
        models: ids.map((id) => {
          const entry = findByUpstream(catalogProvider, id);
          return {
            id,
            ...(entry
              ? {
                  catalog: {
                    key: entry.key,
                    ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
                    pricing: entry.pricing,
                  },
                }
              : {}),
          };
        }),
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
