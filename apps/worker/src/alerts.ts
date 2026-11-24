/**
 * Alert evaluation and notification delivery (card 16.2).
 *
 * Rules are evaluated against request_log (error rate, latency, spend), health samples
 * (invalid credential), the gateway's breaker state in Valkey (breaker open) and the size of the
 * usage queue in BullMQ (queue length; card 24.2). Every firing creates an AlertEvent; a silence window plus the
 * unique (ruleId, dedupKey) index prevent duplicate notifications across worker replicas.
 * The dedup key is the silence-window bucket, so two replicas in the same tick collide on it.
 *
 * A failed delivery does not consume the silence window: the event is retried on the following
 * ticks (at most MAX_DELIVERY_ATTEMPTS in total) until one delivery succeeds.
 *
 * Channel URLs are entered by admins, so every request goes through the outbound URL policy
 * (https and public addresses only in production; see `checkOutboundUrl`).
 *
 * Delivery supports:
 * - `webhook`: JSON POST, optionally signed with HMAC-SHA256 (`x-dirouter-signature`)
 * - `slack`: incoming webhook `{ text }`
 * - `telegram`: Bot API `sendMessage`
 * - `email`: SMTP through the shared mailer (`SMTP_URL`, TLS; card 24.2), or an HTTP email relay
 *   when the channel has a `webhookUrl`
 */
import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { BREAKER_STATE_KEY, BreakerStateEntry } from '@dirouter/contracts';
import { type Logger, prefixedId } from '@dirouter/shared';
import { isEmailAddress, type Mailer } from '@dirouter/shared/mail';

export type AlertRuleType =
  'error_rate' | 'latency' | 'budget' | 'invalid_credential' | 'breaker_open' | 'queue_length';

export interface AlertRuleRow {
  id: string;
  organizationId: string;
  name: string;
  type: string;
  threshold: unknown;
  windowMinutes: number;
  silenceMinutes: number;
  channelId: string | null;
  enabled: boolean;
}

export interface AlertEventRow {
  id: string;
  organizationId: string;
  ruleId: string;
  severity: string;
  title: string;
  details: unknown;
  dedupKey: string | null;
  deliveredAt: Date | null;
  deliveryError: string | null;
}

export interface ChannelRow {
  id: string;
  organizationId: string;
  name: string;
  type: string;
  config: unknown;
  enabled: boolean;
}

export interface AlertDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  alertRule: {
    findMany(args: { where: { enabled: boolean } }): Promise<AlertRuleRow[]>;
  };
  alertEvent: {
    findFirst(args: {
      where: { ruleId: string; createdAt: { gte: Date } };
      orderBy?: { createdAt: 'desc' };
    }): Promise<AlertEventRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<AlertEventRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  notificationChannel: {
    findUnique(args: { where: { id: string } }): Promise<ChannelRow | null>;
  };
}

export interface Clock {
  now(): number;
}

/** Reads the breaker hash the gateway writes (an ioredis client fits). */
export interface BreakerStateReader {
  hgetall(key: string): Promise<Record<string, string>>;
}

/** Where `measure` reads values that are not in PostgreSQL. */
export interface MeasureSources {
  breakers?: BreakerStateReader | undefined;
  /** Jobs waiting in the usage queue (waiting, delayed, prioritized). */
  queueLength?: (() => Promise<number>) | undefined;
}

export interface EvaluateOptions {
  db: AlertDb;
  logger: Logger;
  clock?: Clock;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Outbound URL policy overrides (tests); defaults follow NODE_ENV. */
  urlPolicy?: UrlPolicyOptions;
  /** SMTP sender for `email` channels without an HTTP relay. */
  mailer?: Mailer;
  /** Valkey (breaker state) and BullMQ (queue length); a rule whose source is missing is skipped. */
  sources?: MeasureSources;
}

export interface Firing {
  rule: AlertRuleRow;
  value: number;
  threshold: number;
  event: AlertEventRow;
  delivery?: { ok: boolean; error?: string };
}

export interface EvaluateResult {
  evaluated: number;
  fired: Firing[];
  silenced: number;
  skipped: { ruleId: string; type: string; reason: string }[];
  /** Deliveries of earlier events that failed and were tried again in this run. */
  retried: { ruleId: string; eventId: string; ok: boolean }[];
}

/** Total delivery attempts per event (the first one included). */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** One key per rule per silence window; the unique (ruleId, dedupKey) index does the rest. */
export function dedupKeyFor(ruleId: string, now: number, silenceMs: number): string {
  return `${ruleId}:${String(Math.floor(now / silenceMs))}`;
}

/** Rule types that count events, so a missing threshold means "at least one". */
const COUNT_DEFAULTS = new Set(['invalid_credential', 'breaker_open']);

/**
 * Threshold of a rule, or undefined when the rule cannot be evaluated without one. A missing
 * threshold must never be read as 0: a `budget` rule would then fire with zero spend.
 * `invalid_credential` counts failures, so "at least one" is its natural default.
 */
export function thresholdOf(rule: Pick<AlertRuleRow, 'type' | 'threshold'>): number | undefined {
  if (rule.threshold === null || rule.threshold === undefined || rule.threshold === '')
    return COUNT_DEFAULTS.has(rule.type) ? 1 : undefined;
  const value = Number(rule.threshold);
  return Number.isFinite(value) ? value : undefined;
}

function attemptsOf(event: Pick<AlertEventRow, 'details'>): number {
  const attempts = asRecord(event.details).deliveryAttempts;
  return typeof attempts === 'number' ? attempts : 1;
}

const PERCENT = 100;

/** A measured value, with optional extra facts for the event details. */
type Measured = number | { value: number; extra: Record<string, unknown> } | { skip: string };

/**
 * Breakers of this organization's providers and models that are open now or were open during the
 * window. A closed breaker has no entry; an entry older than the window (a replica that died while
 * its breaker was open) no longer counts.
 */
async function openBreakers(
  db: AlertDb,
  reader: BreakerStateReader,
  organizationId: string,
  since: Date,
): Promise<{ scope: string; id: string; state: string }[]> {
  const raw = await reader.hgetall(BREAKER_STATE_KEY);
  const recent: { scope: 'provider' | 'model'; id: string; state: string }[] = [];
  for (const [field, value] of Object.entries(raw)) {
    const separator = field.indexOf(':');
    const scope = field.slice(0, separator);
    if (scope !== 'provider' && scope !== 'model') continue;
    let entry: BreakerStateEntry;
    try {
      entry = BreakerStateEntry.parse(JSON.parse(value));
    } catch {
      continue;
    }
    if (Math.max(entry.at, entry.reopensAt ?? 0) < since.getTime()) continue;
    recent.push({ scope, id: field.slice(separator + 1), state: entry.state });
  }
  if (recent.length === 0) return [];
  const ids = (scope: string) => recent.filter((b) => b.scope === scope).map((b) => b.id);
  const owned = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM providers WHERE organization_id = $1 AND id = ANY($2::text[])
     UNION ALL
     SELECT id FROM models WHERE organization_id = $1 AND id = ANY($3::text[])`,
    organizationId,
    ids('provider'),
    ids('model'),
  );
  const mine = new Set(owned.map((row) => row.id));
  return recent.filter((b) => mine.has(b.id));
}

/** Value of a rule in its natural unit (percent, ms, USD or a count). */
async function measure(
  db: AlertDb,
  rule: AlertRuleRow,
  since: Date,
  sources: MeasureSources,
): Promise<Measured> {
  const type = rule.type as AlertRuleType;
  if (type === 'error_rate') {
    const rows = await db.$queryRawUnsafe<{ total: number; errors: number }[]>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'error')::int AS errors
         FROM request_log
        WHERE organization_id = $1 AND created_at >= $2`,
      rule.organizationId,
      since,
    );
    const row = rows[0];
    if (!row || row.total === 0) return { skip: 'no_traffic' };
    return (row.errors / row.total) * PERCENT;
  }
  if (type === 'latency') {
    const rows = await db.$queryRawUnsafe<{ p95: number | null }[]>(
      `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float8 AS p95
         FROM request_log
        WHERE organization_id = $1 AND created_at >= $2`,
      rule.organizationId,
      since,
    );
    const p95 = rows[0]?.p95;
    if (p95 === null || p95 === undefined) return { skip: 'no_traffic' };
    return p95;
  }
  if (type === 'budget') {
    const rows = await db.$queryRawUnsafe<{ spent: number | null }[]>(
      `SELECT COALESCE(sum(cost_usd), 0)::float8 AS spent
         FROM request_log
        WHERE organization_id = $1 AND created_at >= $2`,
      rule.organizationId,
      since,
    );
    return rows[0]?.spent ?? 0;
  }
  if (type === 'invalid_credential') {
    const rows = await db.$queryRawUnsafe<{ failures: number }[]>(
      `SELECT count(*)::int AS failures
         FROM provider_health_samples
        WHERE error_class = 'auth' AND checked_at >= $1
          AND provider_id IN (SELECT id FROM providers WHERE organization_id = $2)`,
      since,
      rule.organizationId,
    );
    return rows[0]?.failures ?? 0;
  }
  if (type === 'breaker_open') {
    if (!sources.breakers) return { skip: 'no_breaker_source' };
    const open = await openBreakers(db, sources.breakers, rule.organizationId, since);
    return { value: open.length, extra: { breakers: open } };
  }
  if (rule.type === 'queue_length') {
    if (!sources.queueLength) return { skip: 'no_queue_source' };
    // The usage queue is shared by the deployment, so the value is the same for every organization.
    return { value: await sources.queueLength(), extra: { queue: 'usage' } };
  }
  return { skip: 'unknown_rule_type' };
}

function formatValue(type: string, value: number): string {
  if (type === 'error_rate') return `${value.toFixed(2)}%`;
  if (type === 'latency') return `${Math.round(value)} ms`;
  if (type === 'budget') return `$${value.toFixed(4)}`;
  if (type === 'queue_length') return `${String(value)} jobs`;
  if (type === 'breaker_open') return `${String(value)} open`;
  return String(value);
}

export async function evaluateAlerts(options: EvaluateOptions): Promise<EvaluateResult> {
  const { db, logger } = options;
  const now = options.clock?.now() ?? Date.now();
  const rules = await db.alertRule.findMany({ where: { enabled: true } });
  const result: EvaluateResult = {
    evaluated: 0,
    fired: [],
    silenced: 0,
    skipped: [],
    retried: [],
  };
  const deliveryOptions: DeliveryOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    urlPolicy: options.urlPolicy,
    mailer: options.mailer,
  };
  /** Sends one event to the rule's channel and records the outcome on the event. */
  const send = async (rule: AlertRuleRow, event: AlertEventRow, attempt: number) => {
    if (!rule.channelId) return undefined;
    const channel = await db.notificationChannel.findUnique({ where: { id: rule.channelId } });
    // The channel must belong to the rule's organization; anything else is not delivered.
    if (!channel || !channel.enabled || channel.organizationId !== rule.organizationId)
      return undefined;
    const delivery = await deliver(channel, event, deliveryOptions);
    await db.alertEvent
      .update({
        where: { id: event.id },
        data: {
          details: { ...asRecord(event.details), deliveryAttempts: attempt },
          ...(delivery.ok
            ? { deliveredAt: new Date(now), deliveryError: null }
            : { deliveryError: delivery.error ?? 'delivery failed' }),
        },
      })
      .catch((error: unknown) => {
        logger.warn({ err: error, eventId: event.id }, 'failed to save delivery state');
      });
    return delivery;
  };

  for (const rule of rules) {
    result.evaluated += 1;
    const threshold = thresholdOf(rule);
    if (threshold === undefined) {
      result.skipped.push({ ruleId: rule.id, type: rule.type, reason: 'no_threshold' });
      continue;
    }

    // Silence window: one notification per rule per silenceMinutes, even across replicas.
    const silenceMs = Math.max(1, rule.silenceMinutes) * 60_000;
    const recent = await db.alertEvent.findFirst({
      where: { ruleId: rule.id, createdAt: { gte: new Date(now - silenceMs) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      // The window only silences a rule whose notification went out. An event whose delivery
      // failed is sent again here, a bounded number of times, instead of being lost.
      const attempts = attemptsOf(recent);
      if (
        rule.channelId &&
        !recent.deliveredAt &&
        recent.deliveryError &&
        attempts < MAX_DELIVERY_ATTEMPTS
      ) {
        const delivery = await send(rule, recent, attempts + 1);
        if (delivery) {
          result.retried.push({ ruleId: rule.id, eventId: recent.id, ok: delivery.ok });
          logger.info({ ruleId: rule.id, eventId: recent.id, delivery }, 'alert delivery retried');
          continue;
        }
      }
      result.silenced += 1;
      continue;
    }

    const since = new Date(now - Math.max(1, rule.windowMinutes) * 60_000);
    let measured: Measured;
    try {
      measured = await measure(db, rule, since, options.sources ?? {});
    } catch (error) {
      logger.warn({ err: error, ruleId: rule.id }, 'alert measurement failed');
      result.skipped.push({ ruleId: rule.id, type: rule.type, reason: 'measurement_error' });
      continue;
    }
    if (typeof measured === 'object' && 'skip' in measured) {
      result.skipped.push({ ruleId: rule.id, type: rule.type, reason: measured.skip });
      continue;
    }
    const value = typeof measured === 'number' ? measured : measured.value;
    if (!(value >= threshold)) continue;

    const details = {
      type: rule.type,
      value,
      threshold,
      windowMinutes: rule.windowMinutes,
      since: since.toISOString(),
      ...(typeof measured === 'number' ? {} : measured.extra),
    };
    let event: AlertEventRow;
    try {
      event = await db.alertEvent.create({
        data: {
          id: prefixedId('ale'),
          organizationId: rule.organizationId,
          ruleId: rule.id,
          severity: 'warning',
          title: `${rule.name}: ${formatValue(rule.type, value)} (threshold ${formatValue(rule.type, threshold)})`,
          details,
          dedupKey: dedupKeyFor(rule.id, now, silenceMs),
        },
      });
    } catch (error) {
      // The unique (ruleId, dedupKey) index means another replica already created it.
      logger.info({ err: error, ruleId: rule.id }, 'alert event already exists');
      result.silenced += 1;
      continue;
    }

    const delivery = await send(rule, event, 1);
    result.fired.push({ rule, value, threshold, event, ...(delivery ? { delivery } : {}) });
    logger.info({ ruleId: rule.id, eventId: event.id, value, delivery }, 'alert fired');
  }
  return result;
}

// ───── Outbound URL policy (duplicate of apps/control-api/src/alerts/alert-url.ts) ─────

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3], // multicast and reserved
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 127], // unspecified and loopback
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // unique local, includes fd00:ec2::254
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');

/** True for any address a production server must not be made to call. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d` or `::ffff:7f00:1`) is judged by its IPv4 address.
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
  if (mapped) {
    if (mapped[1]) return blocked.check(mapped[1], 'ipv4');
    const high = Number.parseInt(mapped[2] ?? '0', 16);
    const low = Number.parseInt(mapped[3] ?? '0', 16);
    return blocked.check(
      `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`,
      'ipv4',
    );
  }
  return blocked.check(address, 'ipv6');
}

export interface UrlPolicyOptions {
  /** Defaults to NODE_ENV === 'production'. */
  production?: boolean | undefined;
  /** Injected for tests; defaults to the system resolver. */
  lookup?: ((host: string) => Promise<{ address: string }[]>) | undefined;
}

/**
 * http(s) only and no embedded credentials everywhere; in production also https only and every
 * resolved address must be public. Development allows private hosts (local mock services).
 */
export async function checkOutboundUrl(
  raw: string,
  options: UrlPolicyOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'url is not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, error: 'url must use http or https' };
  if (url.username || url.password) return { ok: false, error: 'url must not contain credentials' };
  if (!production) return { ok: true };
  if (url.protocol !== 'https:') return { ok: false, error: 'url must use https' };
  // URL keeps brackets around IPv6 literals.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      const lookup = options.lookup ?? ((name: string) => dnsLookup(name, { all: true }));
      addresses = (await lookup(host)).map((entry) => entry.address);
    } catch {
      return { ok: false, error: 'url host could not be resolved' };
    }
  }
  if (addresses.length === 0) return { ok: false, error: 'url host could not be resolved' };
  if (addresses.some(isBlockedAddress))
    return { ok: false, error: 'url host resolves to a private or reserved address' };
  return { ok: true };
}

export interface DeliveryOptions {
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  now?: number | undefined;
  urlPolicy?: UrlPolicyOptions | undefined;
  mailer?: Mailer | undefined;
}

/** HMAC signature of the exact JSON body (webhook receivers verify with the shared secret). */
export function signWebhook(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function alertText(event: Pick<AlertEventRow, 'title' | 'details'>): string {
  const details = asRecord(event.details);
  const lines = [`🚨 ${event.title}`];
  if (typeof details.since === 'string')
    lines.push(
      `window ${typeof details.windowMinutes === 'number' ? String(details.windowMinutes) : '?'}m since ${details.since}`,
    );
  if (Array.isArray(details.breakers))
    for (const breaker of details.breakers as { scope?: unknown; id?: unknown; state?: unknown }[])
      lines.push(`${String(breaker.scope)} ${String(breaker.id)}: ${String(breaker.state)}`);
  return lines.join('\n');
}

export async function deliver(
  channel: ChannelRow,
  event: Pick<AlertEventRow, 'title' | 'details'>,
  options: DeliveryOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const config = asRecord(channel.config);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
      const allowed = await checkOutboundUrl(url, options.urlPolicy);
      if (!allowed.ok) return { ok: false as const, error: allowed.error };
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
        // Redirects are not followed: a public host must not bounce the request inward.
        redirect: 'manual',
      });
      if (!response.ok) return { ok: false as const, error: `HTTP ${String(response.status)}` };
      return { ok: true as const };
    };

    if (channel.type === 'webhook') {
      const url = typeof config.url === 'string' ? config.url : undefined;
      if (!url) return { ok: false, error: 'webhook url is missing' };
      const body = JSON.stringify({
        type: 'alert',
        event: { title: event.title, details: event.details },
        sentAt: new Date(options.now ?? Date.now()).toISOString(),
      });
      const headers: Record<string, string> = {};
      if (typeof config.secret === 'string' && config.secret.length > 0)
        headers['x-dirouter-signature'] = signWebhook(body, config.secret);
      return await post(url, body, headers);
    }
    if (channel.type === 'slack') {
      const url =
        (typeof config.webhookUrl === 'string' ? config.webhookUrl : undefined) ??
        (typeof config.url === 'string' ? config.url : undefined);
      if (!url) return { ok: false, error: 'slack webhookUrl is missing' };
      return await post(url, { text: alertText(event) });
    }
    if (channel.type === 'telegram') {
      const token = typeof config.botToken === 'string' ? config.botToken : undefined;
      const chatId = config.chatId;
      if (!token || (typeof chatId !== 'string' && typeof chatId !== 'number'))
        return { ok: false, error: 'telegram botToken/chatId is missing' };
      return await post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: alertText(event),
        disable_web_page_preview: true,
      });
    }
    if (channel.type === 'email') {
      const to = emailRecipients(config.to);
      if (!to) return { ok: false, error: 'email channel needs valid recipient addresses (to)' };
      const url =
        (typeof config.webhookUrl === 'string' ? config.webhookUrl : undefined) ??
        (typeof config.url === 'string' ? config.url : undefined);
      // A channel with an HTTP relay keeps using it; every other email channel goes out over SMTP.
      if (url)
        return await post(url, { to: config.to, subject: event.title, text: alertText(event) });
      if (!options.mailer?.enabled)
        return { ok: false, error: 'SMTP is not configured on the worker (SMTP_URL)' };
      const sent = await options.mailer.send({
        to,
        subject: `[DiRouter] ${event.title}`,
        text: alertText(event),
      });
      return sent.ok ? { ok: true } : { ok: false, error: sent.error };
    }
    return { ok: false, error: `unsupported channel type '${channel.type}'` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'delivery failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** `to` as a list of plain addresses (a string may hold several, comma separated). */
export function emailRecipients(value: unknown): string[] | undefined {
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return list.length > 0 && list.length <= 20 && list.every(isEmailAddress) ? list : undefined;
}

/** Test message used by the control-api "send test" endpoint. */
export async function sendTestMessage(
  channel: ChannelRow,
  options: DeliveryOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  return deliver(
    channel,
    {
      title: `Test message for channel '${channel.name}'`,
      details: { test: true, at: new Date(options.now ?? Date.now()).toISOString() },
    },
    options,
  );
}
