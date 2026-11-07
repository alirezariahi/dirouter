/**
 * طبقه‌بندی خطاهای upstream (کارت ۵.۲).
 *
 * قاعدهٔ اصلی: `bad_request` (و خطاهای محتوا) هرگز به provider دیگر فرستاده
 * نمی‌شود؛ این تصمیم این‌جا گرفته می‌شود، نه در config، تا قابل دور زدن نباشد.
 */
import type { UpstreamErrorClass } from '@dirouter/contracts';

export interface ClassifiedError {
  class: UpstreamErrorClass;
  /** تلاش دوباره روی همان هدف منطقی است. */
  retryable: boolean;
  /** رفتن به هدف بعدی combo مجاز است (اگر fallbackOn هم اجازه دهد). */
  fallbackAllowed: boolean;
  /** credential باید غیرفعال/cooldown شود (کلید نامعتبر یا به سقف رسیده). */
  credentialAction?: 'disable' | 'cooldown';
  retryAfterMs?: number;
  status?: number;
  message: string;
  /** نوع/کد خام provider برای لاگ. */
  upstreamType?: string;
}

const BEHAVIOR: Record<
  UpstreamErrorClass,
  Pick<ClassifiedError, 'retryable' | 'fallbackAllowed' | 'credentialAction'>
> = {
  rate_limit: { retryable: true, fallbackAllowed: true, credentialAction: 'cooldown' },
  overloaded: { retryable: true, fallbackAllowed: true },
  server: { retryable: true, fallbackAllowed: true },
  timeout: { retryable: true, fallbackAllowed: true },
  connection: { retryable: true, fallbackAllowed: true },
  auth: { retryable: false, fallbackAllowed: true, credentialAction: 'disable' },
  not_found: { retryable: false, fallbackAllowed: true },
  context_length: { retryable: false, fallbackAllowed: true },
  content_filter: { retryable: false, fallbackAllowed: false },
  bad_request: { retryable: false, fallbackAllowed: false },
};

export function classified(
  cls: UpstreamErrorClass,
  extra: Omit<ClassifiedError, 'class' | 'retryable' | 'fallbackAllowed'>,
): ClassifiedError {
  return { class: cls, ...BEHAVIOR[cls], ...extra };
}

const CONTEXT_PATTERNS = [
  /context[_ ]length/i,
  /maximum context/i,
  /prompt is too long/i,
  /too many tokens/i,
  /context window/i,
  /input is too long/i,
];
const POLICY_PATTERNS = [/content[_ ]policy/i, /content[_ ]filter/i, /safety/i, /flagged/i];

/** مدت Retry-After از هدرها (ثانیه، تاریخ HTTP، یا ms). */
export function retryAfterFrom(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms));
  const value = headers.get('retry-after');
  if (value) {
    if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  // OpenAI: x-ratelimit-reset-requests: "1s" | "6m0s" | "120ms"
  const reset =
    headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens');
  if (reset) {
    let total = 0;
    for (const [, n, unit] of reset.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
      const v = Number(n);
      total +=
        unit === 'ms' ? v : unit === 's' ? v * 1000 : unit === 'm' ? v * 60_000 : v * 3_600_000;
    }
    if (total > 0) return Math.round(total);
  }
  return undefined;
}

export interface HttpErrorInput {
  status: number;
  headers: Headers;
  /** بدنهٔ خام پاسخ (حداکثر چند کیلوبایت). */
  body: string;
}

/** استخراج پیام و نوع از بدنهٔ خطای OpenAI یا Anthropic یا متن ساده. */
export function errorDetails(body: string): { message: string; type?: string; code?: string } {
  try {
    const json = JSON.parse(body) as {
      error?: { message?: unknown; type?: unknown; code?: unknown } | string;
      message?: unknown;
    };
    const err = json.error;
    if (typeof err === 'string') return { message: err };
    if (err && typeof err === 'object') {
      return {
        message: typeof err.message === 'string' ? err.message : body.slice(0, 500),
        ...(typeof err.type === 'string' ? { type: err.type } : {}),
        ...(typeof err.code === 'string' ? { code: err.code } : {}),
      };
    }
    if (typeof json.message === 'string') return { message: json.message };
  } catch {
    // متن غیر JSON
  }
  return { message: body.slice(0, 500) || 'upstream error' };
}

/** طبقه‌بندی عمومی یک پاسخ HTTP خطا؛ آداپترها می‌توانند آن را دقیق‌تر کنند. */
export function classifyHttpError({ status, headers, body }: HttpErrorInput): ClassifiedError {
  const { message, type, code } = errorDetails(body);
  const hint = `${type ?? ''} ${code ?? ''} ${message}`;
  const base = { status, message, ...(type || code ? { upstreamType: code ?? type } : {}) };

  if (status === 429) {
    // insufficient_quota یعنی اعتبار کلید تمام شده، نه محدودیت لحظه‌ای.
    if (/insufficient_quota|billing/i.test(hint))
      return { ...classified('rate_limit', base), credentialAction: 'disable' };
    const retryAfterMs = retryAfterFrom(headers);
    return classified('rate_limit', {
      ...base,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status === 529 || /overloaded/i.test(type ?? '')) return classified('overloaded', base);
  if (status === 401 || status === 403) return classified('auth', base);
  if (status === 404) return classified('not_found', base);
  if (status === 408) return classified('timeout', base);
  if (status === 413) return classified('context_length', base);
  if (status >= 500) {
    const retryAfterMs = retryAfterFrom(headers);
    return classified(status === 503 && /overload/i.test(message) ? 'overloaded' : 'server', {
      ...base,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (CONTEXT_PATTERNS.some((p) => p.test(hint))) return classified('context_length', base);
  if (POLICY_PATTERNS.some((p) => p.test(hint))) return classified('content_filter', base);
  return classified('bad_request', base);
}

/** خطای سطح شبکه (fetch/undici) یا abort. */
export function classifyNetworkError(error: unknown, timedOut: boolean): ClassifiedError {
  if (timedOut) return classified('timeout', { message: 'upstream timeout' });
  const err = error as {
    name?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = err.cause?.code ?? '';
  const message = err.cause?.message ?? err.message ?? 'network error';
  if (
    err.name === 'TimeoutError' ||
    /ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/.test(code)
  ) {
    return classified('timeout', { message });
  }
  return classified('connection', { message: code ? `${code}: ${message}` : message });
}
