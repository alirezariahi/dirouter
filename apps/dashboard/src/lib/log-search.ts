/** search params صفحهٔ Request Log (جدا از صفحه تا router آن را lazy نگه دارد). */
export interface LogSearch {
  from?: string;
  to?: string;
  model?: string;
  apiKeyId?: string;
  projectId?: string;
  status?: 'success' | 'error';
}

export const LOG_FILTERS = ['model', 'apiKeyId', 'projectId', 'status'] as const;

/** اعتبارسنجی search params (فقط رشته‌های معتبر می‌مانند). */
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
  for (const k of ['model', 'apiKeyId', 'projectId'] as const) {
    const v = str(raw[k]);
    if (v) out[k] = v;
  }
  if (raw.status === 'success' || raw.status === 'error') out.status = raw.status;
  return out;
}
