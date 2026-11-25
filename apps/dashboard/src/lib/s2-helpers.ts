/**
 * Pure helpers of the Sprint 2 pages, kept out of the page modules so they can be unit-tested
 * without rendering anything.
 */
import type { LogSearch } from './log-search';

export interface MetricPoint {
  requests: number;
  errors: number;
  costUsd: string;
  inputTokens?: number;
  outputTokens?: number;
}
export type Metric = 'requests' | 'cost' | 'errors' | 'tokens';
export type ChannelType = 'webhook' | 'slack' | 'telegram' | 'email';
/** The fields of the guardrail form that end up in a policy's `config`. */
export interface GuardrailDraft {
  type: string;
  pattern: string;
  flags: string;
  terms: string;
  piiType: string;
  maxTokens: string;
  schema: string;
  /** `moderation` (card 23.2) and the injection classifier (card 23.3). */
  model?: string;
  mode?: string;
  failMode?: string;
  timeoutMs?: string;
}

/** Rollup and ledger totals agree when they differ by less than a hundredth of a cent. */
export function reconciles(rollupUsd: string, ledgerUsd: string): boolean {
  return Math.abs(Number(rollupUsd) - Number(ledgerUsd)) < 0.0001;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * The worker recomputes the current and previous hour (and their days) every ROLLUP_INTERVAL_MS
 * (30 s by default), and usage is written in small batches before that. A bucket is treated as
 * final once it has been closed for this long.
 */
export const ROLLUP_GRACE_MS = 2 * 60_000;

export interface SettledWindow {
  /** `to` to send to `/stats/cost` so both totals cover only fully rolled-up buckets. */
  to: string;
  /** First instant that is not part of the comparison (start of the still-open bucket). */
  boundary: string;
  /** Rollup table the server reads for this window. */
  granularity: 'hour' | 'day';
}

/**
 * Window over which rollups and the ledger can be compared soundly. The API exposes no rollup
 * watermark, so the end is derived: the last closed bucket of the table the server reads for the
 * range (`usage_daily` for ranges over 7 days, `usage_hourly` otherwise), minus a grace period.
 * Returns undefined when no closed bucket lies inside the range.
 *
 * The daily window is inclusive of the whole UTC day of `to` on the server, so its `to` is the
 * last millisecond of the previous closed day; the hourly window is exclusive of `to`.
 */
export function settledWindow(
  fromIso: string,
  toIso: string,
  now: number = Date.now(),
): SettledWindow | undefined {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return undefined;
  const daily = to - from > 7 * DAY_MS;
  const bucket = daily ? DAY_MS : HOUR_MS;
  const boundary = Math.min(Math.floor((now - ROLLUP_GRACE_MS) / bucket) * bucket, to);
  const end = daily ? boundary - 1 : boundary;
  // The shortened window must still select the same rollup table and contain a closed bucket.
  if (end <= from || (daily && end - from <= 7 * DAY_MS)) return undefined;
  return {
    to: new Date(end).toISOString(),
    boundary: new Date(boundary).toISOString(),
    granularity: daily ? 'day' : 'hour',
  };
}

export interface Reconciliation {
  /** Totals agree over the settled window. */
  matches: boolean;
  /** Absolute difference over the settled window. */
  diffUsd: number;
  /** Ledger spend after the settled window: recorded, but not yet final in the rollups. */
  pendingUsd: number;
}

/**
 * Compares rollups with the ledger over the settled window only. What the live ledger total holds
 * beyond it is reported as pending aggregation, never as a mismatch.
 */
export function reconcile(
  settled: { rollupUsd: string; ledgerUsd: string },
  liveLedgerUsd: string,
): Reconciliation {
  const diffUsd = Math.abs(Number(settled.rollupUsd) - Number(settled.ledgerUsd));
  return {
    matches: reconciles(settled.rollupUsd, settled.ledgerUsd),
    diffUsd,
    pendingUsd: Math.max(0, Number(liveLedgerUsd) - Number(settled.ledgerUsd)),
  };
}

/** Rule types the API accepts for new rules; `breaker_open` and `queue_length` are refused. */
export const RULE_TYPES = ['error_rate', 'latency', 'budget', 'invalid_credential'] as const;
/** Rule types that cannot fire without a threshold (THRESHOLD_REQUIRED in the control-api). */
export const THRESHOLD_RULE_TYPES: readonly string[] = ['error_rate', 'latency', 'budget'];

/** Why a rule draft cannot be sent, or undefined when it is fine. */
export function ruleProblem(rule: {
  type: string;
  threshold: string;
}): 'thresholdRequired' | 'thresholdInvalid' | 'typeUnsupported' | undefined {
  if (!(RULE_TYPES as readonly string[]).includes(rule.type)) return 'typeUnsupported';
  const text = rule.threshold.trim();
  if (text === '')
    return THRESHOLD_RULE_TYPES.includes(rule.type) ? 'thresholdRequired' : undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? undefined : 'thresholdInvalid';
}

/** Poll interval; with the ~200 ms usage write batch this keeps the display delay under 2 seconds. */
export const LIVE_REFRESH_MS = 1_000;

export interface LiveCounts {
  /** Rows the numbers were counted from (the endpoint returns at most 50). */
  sample: number;
  lastMinute: number;
  errors: number;
  /** Every fetched row is from the last minute, so the real per-minute count may be higher. */
  saturated: boolean;
}

/** Counts within the fetched rows of the live view; `now` is the server's `generatedAt`. */
export function liveCounts(
  items: readonly { createdAt: string; status: string }[],
  now: number,
  pageSize = 50,
): LiveCounts {
  const lastMinute = items.filter((item) => now - Date.parse(item.createdAt) <= 60_000).length;
  return {
    sample: items.length,
    lastMinute,
    errors: items.filter((item) => item.status !== 'success').length,
    saturated: items.length >= pageSize && lastMinute === items.length,
  };
}

/** Median of a list (0 for an empty list). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Which Request Log filter a breakdown row maps to. */
export const DRILL: Record<'byModel' | 'byKey' | 'byProject' | 'byProvider', keyof LogSearch> = {
  byModel: 'model',
  byKey: 'apiKeyId',
  byProject: 'projectId',
  byProvider: 'providerId',
};

export function metricValue(point: MetricPoint, metric: Metric): number {
  if (metric === 'cost') return Number(point.costUsd);
  if (metric === 'errors') return point.errors;
  if (metric === 'tokens') return (point.inputTokens ?? 0) + (point.outputTokens ?? 0);
  return point.requests;
}

export const MAX_MODELS = 4;

/** Adds or removes a model, never exceeding the limit. */
export function toggleModel(selected: string[], slug: string, max = MAX_MODELS): string[] {
  if (selected.includes(slug)) return selected.filter((item) => item !== slug);
  return selected.length >= max ? selected : [...selected, slug];
}

/** Parses a JSON object; returns undefined for anything else (arrays, scalars, invalid text). */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Channel `config` for each type, as the worker's delivery code reads it. */
export function channelConfig(
  type: ChannelType,
  form: { url: string; secret: string; botToken: string; chatId: string; to: string },
): Record<string, string> {
  if (type === 'webhook') return { url: form.url, ...(form.secret ? { secret: form.secret } : {}) };
  if (type === 'slack') return { webhookUrl: form.url };
  if (type === 'telegram') return { botToken: form.botToken, chatId: form.chatId };
  return { webhookUrl: form.url, to: form.to };
}

/** What the API shows instead of a stored secret; sending it back means "keep". */
export const SECRET_MASK = '***';

export interface ChannelForm {
  url: string;
  secret: string;
  botToken: string;
  chatId: string;
  to: string;
}

/**
 * `config` for a channel update. The server replaces the non-secret part of the stored config with
 * what is sent, so the edit form is pre-filled with those values (`channelFormOf`) and they are
 * sent back. A secret field is sent only when the user typed a new value: left blank (or still the
 * mask) it is omitted, which keeps the stored value; a field listed in `clear` is sent as an empty
 * string, which removes it. The mask itself is never posted.
 */
export function channelUpdateConfig(
  type: ChannelType,
  form: ChannelForm,
  clear: readonly string[] = [],
): Record<string, string> {
  const draft: Record<string, string> =
    type === 'webhook'
      ? { url: form.url, secret: form.secret }
      : type === 'slack'
        ? { webhookUrl: form.url }
        : type === 'telegram'
          ? { botToken: form.botToken, chatId: form.chatId }
          : { webhookUrl: form.url, to: form.to };
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(draft)) {
    const value = raw.trim();
    if (clear.includes(key)) out[key] = '';
    else if (value !== '' && value !== SECRET_MASK) out[key] = value;
  }
  return out;
}

/** Edit-form values of a stored channel: masked secrets start blank, everything else is shown. */
export function channelFormOf(type: ChannelType, config: unknown): ChannelForm {
  const stored = (config !== null && typeof config === 'object' ? config : {}) as Record<
    string,
    unknown
  >;
  const plain = (key: string) => {
    const value = stored[key];
    return typeof value === 'string' && value !== SECRET_MASK ? value : '';
  };
  return {
    url: plain(type === 'webhook' ? 'url' : 'webhookUrl'),
    secret: plain('secret'),
    botToken: plain('botToken'),
    chatId: plain('chatId'),
    to: plain('to'),
  };
}

/** Builds the `config` object of a policy from the form; throws on invalid JSON Schema text. */
function callLimits(draft: GuardrailDraft): Record<string, unknown> {
  return {
    failMode: draft.failMode === 'closed' ? 'closed' : 'open',
    ...(draft.timeoutMs && Number(draft.timeoutMs) > 0
      ? { timeoutMs: Math.round(Number(draft.timeoutMs)) }
      : {}),
  };
}

export function configOf(draft: GuardrailDraft): Record<string, unknown> {
  switch (draft.type) {
    case 'regex':
      return { pattern: draft.pattern, ...(draft.flags ? { flags: draft.flags } : {}) };
    case 'keyword':
      return {
        terms: draft.terms
          .split(',')
          .map((term) => term.trim())
          .filter(Boolean),
      };
    case 'pii':
      return { type: draft.piiType };
    case 'max_input_tokens':
      return { maxTokens: Number(draft.maxTokens) };
    case 'json_schema':
      return { schema: JSON.parse(draft.schema) as unknown };
    case 'moderation':
      return {
        model: draft.model?.trim() ?? '',
        ...callLimits(draft),
        mode: draft.mode ?? 'moderations',
      };
    case 'prompt_injection':
      // The classifier is optional: without a model only the built-in patterns run.
      return draft.model?.trim()
        ? { classifier: { model: draft.model.trim(), ...callLimits(draft) } }
        : {};
    default:
      return {};
  }
}
