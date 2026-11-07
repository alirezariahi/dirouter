/**
 * سناریوی رفتار mock از یک رشته directive، مثلاً
 * `status=429,retry_after=2` یا `latency=100-300,error_rate=0.2` یا `stream_drop_after=3`.
 *
 * منبع directive به ترتیب اولویت: هدر `x-mock`، کلید API به شکل `mock:<directives>`،
 * و پیش‌فرض سراسری (`MOCK_DEFAULT` یا `PUT /__mock/config`).
 */
export interface Scenario {
  /** وضعیت خطای ثابت (مثلاً 429، 500، 503، 529، 401، 400). */
  status?: number;
  /** احتمال خطای 503 (۰ تا ۱). */
  errorRate: number;
  retryAfter?: number;
  latency: [number, number];
  /** تأخیر پیش از ارسال هدر و اولین chunk. */
  ttftMs: number;
  /** فاصلهٔ بین chunkهای stream. */
  chunkDelayMs: number;
  chunks: number;
  /** قطع اتصال بعد از n chunk. */
  dropAfter?: number;
  /** پاسخ با فراخوانی این ابزار. */
  tool?: string;
  text: string;
  /** خطای طول کانتکست (400). */
  contextLength: boolean;
  /** بدون usage در پاسخ (برای تست تخمین توکن). */
  noUsage: boolean;
}

export const DEFAULT_SCENARIO: Scenario = {
  errorRate: 0,
  latency: [0, 0],
  ttftMs: 0,
  chunkDelayMs: 0,
  chunks: 5,
  text: 'Hello from the DiRouter mock provider.',
  contextLength: false,
  noUsage: false,
};

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? fallback : n;
};

export function parseScenario(
  directives: string | undefined,
  base: Scenario = DEFAULT_SCENARIO,
): Scenario {
  const s: Scenario = { ...base, latency: [...base.latency] };
  if (!directives) return s;
  for (const raw of directives.split(/[,;]/)) {
    const [key = '', value] = raw
      .trim()
      .split('=', 2)
      .map((x) => x.trim());
    switch (key) {
      case 'status':
        s.status = num(value, 500);
        break;
      case 'rate_limit':
        s.status = 429;
        break;
      case 'overloaded':
        s.status = 529;
        break;
      case 'auth':
        s.status = 401;
        break;
      case 'context_length':
        s.contextLength = true;
        break;
      case 'retry_after':
        s.retryAfter = num(value, 1);
        break;
      case 'error_rate':
        s.errorRate = Math.min(1, Math.max(0, num(value, 0)));
        break;
      case 'latency': {
        const [min, max] = (value ?? '0').split('-').map((x) => num(x, 0));
        s.latency = [min ?? 0, max ?? min ?? 0];
        break;
      }
      case 'ttft':
        s.ttftMs = num(value, 0);
        break;
      case 'chunk_delay':
        s.chunkDelayMs = num(value, 0);
        break;
      case 'chunks':
        s.chunks = Math.max(1, num(value, 5));
        break;
      case 'drop_after':
      case 'stream_drop_after':
        s.dropAfter = num(value, 1);
        break;
      case 'tool':
        s.tool = value ?? 'get_weather';
        break;
      case 'text':
        s.text = value ?? s.text;
        break;
      case 'no_usage':
        s.noUsage = true;
        break;
      case '':
        break;
      default:
        break;
    }
  }
  return s;
}

/** directive از کلید API: `Bearer mock:status=503` یا هدر `x-api-key: mock:...`. */
export function directivesFromKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const token = key.replace(/^Bearer\s+/i, '');
  return token.startsWith('mock:') ? token.slice(5) : undefined;
}

export function sampleLatency([min, max]: [number, number]): number {
  return max <= min ? min : min + Math.random() * (max - min);
}
