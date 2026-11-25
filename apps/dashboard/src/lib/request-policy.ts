/** Request policy of a model or an alias (sprint 5, epic 31), as the control API takes it. */
export interface RequestPolicy {
  autoCache?: boolean;
  autoCacheTtl?: '5m' | '1h';
  /** Card 31.4: parameter defaults, forced values, removals and parameters the model refuses. */
  defaults?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  drop?: string[];
  unsupported?: string[];
}

const empty = (value: unknown) =>
  value === undefined ||
  value === false ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'object' && value !== null && Object.keys(value).length === 0);

/** The policy as the API takes it: `null` when nothing is set. */
export function policyBody(policy: RequestPolicy): RequestPolicy | null {
  const clean = Object.fromEntries(
    Object.entries(policy).filter(([, value]) => !empty(value)),
  ) as RequestPolicy;
  return Object.keys(clean).length > 0 ? clean : null;
}

/** A JSON object typed by hand, or an error key when it is not one. */
export function parseParams(text: string): Record<string, unknown> | 'invalid' {
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

/** Comma- or space-separated parameter names. */
export const paramList = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
