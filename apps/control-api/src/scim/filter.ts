/**
 * The subset of SCIM filters identity providers send before creating or linking a resource:
 * `attr eq "value"` clauses joined with `and` (RFC 7644 §3.4.2.2). Attribute names and string
 * comparison are case-insensitive, except `id` and `externalId`.
 */
import { ScimError } from './errors.js';

export interface Clause {
  path: string;
  value: string | boolean;
}

const CLAUSE =
  /^\s*([A-Za-z][\w.]*(?:\[[^\]]*\])?(?:\.\w+)?)\s+eq\s+("(?:[^"\\]|\\.)*"|true|false)\s*$/i;
const CASE_EXACT = new Set(['id', 'externalid']);

export function parseFilter(filter: string | undefined): Clause[] {
  if (!filter?.trim()) return [];
  return filter.split(/\s+and\s+/i).map((part) => {
    const match = CLAUSE.exec(part);
    if (!match?.[1] || !match[2])
      throw new ScimError(400, `unsupported filter: ${filter.slice(0, 200)}`, 'invalidFilter');
    // emails[type eq "work"].value and emails.value both mean the e-mail addresses.
    const path = match[1].replace(/\[[^\]]*\]/, '').toLowerCase();
    const raw = match[2];
    const value =
      raw.toLowerCase() === 'true'
        ? true
        : raw.toLowerCase() === 'false'
          ? false
          : (JSON.parse(raw) as string);
    return { path, value };
  });
}

function valuesAt(resource: unknown, path: string): unknown[] {
  let current: unknown[] = [resource];
  for (const segment of path.split('.')) {
    current = current.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const entry = Object.entries(item as Record<string, unknown>).find(
        ([key]) => key.toLowerCase() === segment,
      );
      const value: unknown = entry?.[1];
      return Array.isArray(value) ? (value as unknown[]) : value === undefined ? [] : [value];
    });
  }
  return current;
}

export function matchesFilter(resource: Record<string, unknown>, clauses: Clause[]): boolean {
  return clauses.every(({ path, value }) =>
    valuesAt(resource, path).some((candidate) =>
      typeof value === 'string' && typeof candidate === 'string'
        ? CASE_EXACT.has(path)
          ? candidate === value
          : candidate.toLowerCase() === value.toLowerCase()
        : candidate === value,
    ),
  );
}
