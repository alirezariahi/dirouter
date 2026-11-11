/** Request Log page search params (kept apart from the page so the router can lazy-load it). */
export interface LogSearch {
  from?: string;
  to?: string;
  model?: string;
  apiKeyId?: string;
  projectId?: string;
  providerId?: string;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  minCostUsd?: string;
  maxCostUsd?: string;
  status?: 'success' | 'error';
}

export const LOG_FILTERS = [
  'model',
  'apiKeyId',
  'projectId',
  'providerId',
  'status',
  'minLatencyMs',
  'maxLatencyMs',
  'minCostUsd',
  'maxCostUsd',
] as const;

/** Validates search params (only valid strings are kept). */
export function validateLogSearch(raw: Record<string, unknown>): LogSearch {
  const str = (v: unknown) =>
    typeof v === 'string' && v !== '' && v.length <= 256 ? v : undefined;
  const iso = (v: unknown) => {
    const s = str(v);
    return s && !Number.isNaN(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : undefined;
  };
  const out: LogSearch = {};
  const from = iso(raw.from);
  const to = iso(raw.to);
  if (from) out.from = from;
  if (to) out.to = to;
  for (const k of ['model', 'apiKeyId', 'projectId', 'providerId'] as const) {
    const v = str(raw[k]);
    if (v) out[k] = v;
  }
  for (const k of ['minLatencyMs', 'maxLatencyMs'] as const) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  for (const k of ['minCostUsd', 'maxCostUsd'] as const) {
    const v = str(raw[k]);
    if (v && /^\d{1,10}(\.\d{1,8})?$/.test(v)) out[k] = v;
  }
  if (raw.status === 'success' || raw.status === 'error') out.status = raw.status;
  return out;
}
