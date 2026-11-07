/**
 * فراخوانی upstream با timeoutهای چندلایه (کارت ۵.۴) و proxy خروجی (کارت ۴.۱۰).
 *
 * - connect: در undici Agent هر provider
 * - firstByte (TTFT): تا رسیدن هدر پاسخ (و برای stream تا اولین chunk)
 * - idle: سکوت بین دو chunk در stream
 * - total: deadline کل تلاش
 * همهٔ timeoutها با AbortController به upstream منتقل می‌شوند.
 */
import type { ProviderConfig, TimeoutConfig } from '@dirouter/contracts';
import type { UpstreamRequest } from '@dirouter/providers';
import { Agent, type Dispatcher, ProxyAgent, fetch } from 'undici';

export type TimeoutKind = 'connect' | 'first_byte' | 'idle' | 'total';

export class UpstreamTimeout extends Error {
  override readonly name = 'UpstreamTimeout';
  constructor(readonly kind: TimeoutKind) {
    super(`upstream ${kind} timeout`);
  }
}

export const DEFAULT_TIMEOUTS: Required<TimeoutConfig> = {
  connectMs: 5_000,
  firstByteMs: 60_000,
  idleMs: 60_000,
  totalMs: 600_000,
};

export function mergeTimeouts(...layers: (TimeoutConfig | undefined)[]): Required<TimeoutConfig> {
  const merged: Required<TimeoutConfig> = { ...DEFAULT_TIMEOUTS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const k of ['connectMs', 'firstByteMs', 'idleMs', 'totalMs'] as const) {
      const v = layer[k];
      if (v !== undefined) merged[k] = v;
    }
  }
  return merged;
}

const dispatchers = new Map<string, Dispatcher>();

/** یک dispatcher (connection pool) به ازای provider؛ bulkhead اتصال‌ها جداست. */
export function dispatcherFor(provider: ProviderConfig, connectMs: number): Dispatcher {
  const proxyUrl = provider.proxy?.url;
  const cacheKey = `${provider.id}|${connectMs}|${proxyUrl ?? ''}`;
  let d = dispatchers.get(cacheKey);
  if (!d) {
    const common = {
      connect: { timeout: connectMs },
      keepAliveTimeout: 30_000,
      connections: provider.maxConcurrency ?? 256,
    };
    if (proxyUrl && /^https?:/.test(proxyUrl)) d = new ProxyAgent({ uri: proxyUrl, ...common });
    else if (proxyUrl) throw new Error('SOCKS5 proxy support is not implemented yet');
    else d = new Agent(common);
    dispatchers.set(cacheKey, d);
  }
  return d;
}

export interface UpstreamCall {
  response: Awaited<ReturnType<typeof fetch>>;
  /** پاک کردن timerها بعد از پایان کار. */
  done(): void;
  /** شروع دوبارهٔ timer سکوت (هر chunk). */
  touch(): void;
  signal: AbortSignal;
}

/**
 * ارسال درخواست. `stream` تعیین می‌کند timer TTFT پس از هدر هم تا اولین chunk
 * ادامه یابد و idle فعال شود.
 */
export async function callUpstream(
  provider: ProviderConfig,
  up: UpstreamRequest,
  timeouts: Required<TimeoutConfig>,
  parent: AbortSignal,
  stream: boolean,
): Promise<UpstreamCall> {
  const controller = new AbortController();
  let reason: TimeoutKind | undefined;
  const abortFor = (kind: TimeoutKind) => () => {
    reason = kind;
    controller.abort(new UpstreamTimeout(kind));
  };
  const onParent = () => {
    controller.abort(parent.reason);
  };
  if (parent.aborted) onParent();
  parent.addEventListener('abort', onParent, { once: true });

  const total = setTimeout(abortFor('total'), timeouts.totalMs);
  // برای non-stream مدل کل پاسخ را می‌سازد؛ TTFT فقط برای stream معنی دارد.
  let firstByte: NodeJS.Timeout | undefined = stream
    ? setTimeout(abortFor('first_byte'), timeouts.firstByteMs)
    : undefined;
  let idle: NodeJS.Timeout | undefined;

  const done = () => {
    clearTimeout(total);
    clearTimeout(firstByte);
    clearTimeout(idle);
    parent.removeEventListener('abort', onParent);
  };

  try {
    const response = await fetch(up.url, {
      method: up.method,
      headers: up.headers,
      ...(up.body !== undefined ? { body: up.body } : {}),
      signal: controller.signal,
      dispatcher: dispatcherFor(provider, timeouts.connectMs),
    });
    return {
      response,
      done,
      signal: controller.signal,
      touch: () => {
        if (!stream) return;
        clearTimeout(firstByte);
        firstByte = undefined;
        clearTimeout(idle);
        idle = setTimeout(abortFor('idle'), timeouts.idleMs);
      },
    };
  } catch (error) {
    done();
    if (reason) throw new UpstreamTimeout(reason);
    throw error;
  }
}

/** متن بدنهٔ خطا با سقف اندازه (پاسخ خطای بزرگ حافظه را پر نکند). */
export async function readErrorBody(
  response: Awaited<ReturnType<typeof fetch>>,
  limit = 16_384,
): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, limit);
  } catch {
    return '';
  }
}
