/**
 * Realtime WebSocket targets (card 30.5): where and how the gateway opens the upstream session.
 *
 * | type                            | URL                                                  | auth            |
 * | ------------------------------- | ---------------------------------------------------- | --------------- |
 * | openai, openai-compatible, mock | `{baseUrl}/realtime?model={upstreamModel}`           | Bearer          |
 * | azure-openai                    | `{baseUrl}/openai/v1/realtime?model={deployment}`    | api-key / Entra |
 *
 * The beta protocol (`OpenAI-Beta: realtime=v1`) is passed on when the client asked for it; Azure
 * then uses its preview path with `api-version` and `deployment`.
 */
import type { ProviderType } from '@dirouter/contracts';

import type { MediaContext } from './media.js';

export interface RealtimeTarget {
  /** `ws:` or `wss:` URL. */
  url: string;
  headers: Record<string, string>;
}

export interface RealtimeOptions {
  /** The client speaks the beta protocol. */
  beta: boolean;
}

/** Azure's last preview API version of the beta Realtime protocol. */
export const AZURE_REALTIME_PREVIEW_VERSION = '2025-04-01-preview';

const REALTIME_TYPES: readonly ProviderType[] = [
  'openai',
  'openai-compatible',
  'mock',
  'azure-openai',
];

export function supportsRealtime(type: ProviderType): boolean {
  return REALTIME_TYPES.includes(type);
}

/** `https://host/v1` → `wss://host/v1` (and `http` → `ws`). */
export function toWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl.replace(/\/+$/, ''));
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString().replace(/\/+$/, '');
}

export function realtimeTarget(
  ctx: MediaContext,
  options: RealtimeOptions,
): RealtimeTarget | undefined {
  const base = toWebSocketUrl(ctx.provider.baseUrl);
  const beta: Record<string, string> = options.beta ? { 'openai-beta': 'realtime=v1' } : {};
  const model = encodeURIComponent(ctx.model.upstreamModel);
  switch (ctx.provider.type) {
    case 'openai':
    case 'openai-compatible':
    case 'mock':
      return {
        url: `${base}/realtime?model=${model}`,
        headers: {
          ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
          ...beta,
          ...ctx.credentialHeaders,
        },
      };
    case 'azure-openai': {
      const auth: Record<string, string> =
        ctx.provider.options.authMode === 'entra'
          ? { authorization: `Bearer ${ctx.apiKey}` }
          : { 'api-key': ctx.apiKey };
      const apiVersion =
        typeof ctx.provider.options.realtimeApiVersion === 'string'
          ? ctx.provider.options.realtimeApiVersion
          : AZURE_REALTIME_PREVIEW_VERSION;
      return {
        url: options.beta
          ? `${base}/openai/realtime?api-version=${encodeURIComponent(apiVersion)}&deployment=${model}`
          : `${base}/openai/v1/realtime?model=${model}`,
        headers: { ...auth, ...beta, ...ctx.credentialHeaders },
      };
    }
    default:
      return undefined;
  }
}
