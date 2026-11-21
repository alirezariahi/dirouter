/** Snapshot diff and import parsing for versioned config (card 17.1); free of framework imports. */
import { DiRouterError } from '@dirouter/shared';

export type DiffEntry = { path: string; before?: unknown; after?: unknown };

export function diff(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (before === after) return [];
  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object' ||
    Array.isArray(before) !== Array.isArray(after)
  )
    return [{ path: path || '(root)', before, after }];
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: DiffEntry[] = [];
  for (const key of keys) out.push(...diff(a[key], b[key], path ? `${path}.${key}` : key));
  return out;
}

/** Accepts JSON (a valid YAML subset) and rejects anything else without side effects. */
export function parseConfigText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DiRouterError('invalid_request', {
      message: 'import must be JSON/YAML text produced by the export endpoint',
      status: 400,
    });
  }
}
