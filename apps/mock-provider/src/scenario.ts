/**
 * Mock behavior scenario from a directive string, e.g.
 * `status=429,retry_after=2` or `latency=100-300,error_rate=0.2` or `stream_drop_after=3`.
 *
 * Directive sources in priority order: the `x-mock` header, the API key in the form `mock:<directives>`,
 * and the global default (`MOCK_DEFAULT` or `PUT /__mock/config`).
 */
export interface Scenario {
  /** Fixed error status (e.g. 429, 500, 503, 529, 401, 400). */
  status?: number;
  /** Probability of a 503 error (0 to 1). */
  errorRate: number;
  retryAfter?: number;
  latency: [number, number];
  /** Delay before sending the header and first chunk. */
  ttftMs: number;
  /** Interval between stream chunks. */
  chunkDelayMs: number;
  chunks: number;
  /** Drop the connection after n chunks. */
  dropAfter?: number;
  /** Respond with a call to this tool. */
  tool?: string;
  text: string;
  /** Context length error (400). */
  contextLength: boolean;
  /** No usage in the response (to test token estimation). */
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

/** Directive from the API key: `Bearer mock:status=503` or the `x-api-key: mock:...` header. */
export function directivesFromKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const token = key.replace(/^Bearer\s+/i, '');
  return token.startsWith('mock:') ? token.slice(5) : undefined;
}

export function sampleLatency([min, max]: [number, number]): number {
  return max <= min ? min : min + Math.random() * (max - min);
}
