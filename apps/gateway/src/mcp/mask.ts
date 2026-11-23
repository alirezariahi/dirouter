/**
 * Tool-call arguments as they may be logged (card 20.1): values under secret-looking names are
 * replaced, long strings are cut and deep or wide structures are trimmed, so the log keeps what
 * was asked without keeping what must not be stored.
 */
const SECRET =
  /pass(word)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key|cookie|session/i;
const MAX_STRING = 200;
const MAX_KEYS = 50;
const MAX_DEPTH = 4;

function mask(value: unknown, depth: number): unknown {
  if (typeof value === 'string')
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(${String(value.length)})`
      : value;
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_KEYS).map((v) => mask(v, depth + 1));
    return value.length > MAX_KEYS ? [...items, `…(${String(value.length)})`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS))
    out[k] = SECRET.test(k) ? '***' : mask(v, depth + 1);
  return out;
}

export function maskArguments(args: Record<string, unknown>): Record<string, unknown> {
  return mask(args, 0) as Record<string, unknown>;
}
