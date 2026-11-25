/**
 * Alert rules, notification channels and events (card 16.2). Evaluation/delivery runs in the
 * worker; this module is the admin surface and the "send test" path.
 */
import { createHmac } from 'node:crypto';

import { DiRouterError, prefixedId, RateLimitError } from '@dirouter/shared';
import { isEmailAddress, type Mailer } from '@dirouter/shared/mail';
import { Inject, Injectable } from '@nestjs/common';

import { requireVerifiedEmail } from '../auth/acting-human.js';
import { MailService } from '../infra/mail.service.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import type { OrgContext } from '../rbac/org.guard.js';
import { checkOutboundUrl, checkUrlSyntax, type UrlPolicyOptions } from './alert-url.js';

export type ChannelInput = {
  name: string;
  type: 'webhook' | 'slack' | 'telegram' | 'email';
  config?: Record<string, unknown>;
  enabled?: boolean;
};
export type RuleInput = {
  name: string;
  type:
    'error_rate' | 'latency' | 'budget' | 'invalid_credential' | 'breaker_open' | 'queue_length';
  threshold?: number;
  windowMinutes?: number;
  silenceMinutes?: number;
  channelId?: string | null;
  enabled?: boolean;
};

/**
 * "Send test" goes out through the operator's SMTP server or to an admin-entered URL, so it is
 * limited: one test per channel per minute and ten per organization per hour.
 */
export const CHANNEL_TEST_LIMITS = { channelGapSeconds: 60, orgPerHour: 10 } as const;
/**
 * Title of a test notification. Fixed: tenant-chosen text (such as the channel name) must not end
 * up in the subject of an email sent from the operator's address.
 */
export const TEST_ALERT_TITLE = 'Test alert from DiRouter';

/** Shown instead of a stored secret; sending it back on update means "keep the stored value". */
export const SECRET_PLACEHOLDER = '***';
/**
 * Rule types that cannot fire without a threshold. `invalid_credential` and `breaker_open` count
 * events and default to 1 (card 24.2 made `breaker_open` and `queue_length` evaluable).
 */
export const THRESHOLD_REQUIRED = new Set<string>([
  'error_rate',
  'latency',
  'budget',
  'queue_length',
]);

const SECRET_KEYS = ['secret', 'botToken', 'webhookUrl', 'token', 'password', 'apiKey'];
/** Config keys that hold a URL the server will call. */
const URL_KEYS = ['url', 'webhookUrl'];

/** A Slack (or relay) URL is itself the credential, unlike a signed webhook's URL. */
function secretKeys(type: string): string[] {
  return type === 'webhook' ? SECRET_KEYS : [...SECRET_KEYS, 'url'];
}

/** Channel config as any reader may see it, plus the names of the secrets that are set. */
export function redactChannelConfig(type: string, config: unknown) {
  const out = { ...asRecord(config) };
  const secretFields: string[] = [];
  for (const key of secretKeys(type)) {
    const value = out[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = SECRET_PLACEHOLDER;
    secretFields.push(key);
  }
  return { config: out, secretFields, hasSecret: secretFields.length > 0 };
}

/**
 * Config to store on update: a secret that is omitted or still the placeholder keeps its stored
 * value (as long as the channel type is unchanged); `null` or an empty string removes it.
 */
export function mergeChannelConfig(
  type: string,
  incoming: Record<string, unknown>,
  stored: { type: string; config: unknown },
): Record<string, unknown> {
  const previous = stored.type === type ? asRecord(stored.config) : {};
  const secrets = new Set(secretKeys(type));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!secrets.has(key)) out[key] = value;
    else if (value !== SECRET_PLACEHOLDER && value !== null && value !== '') out[key] = value;
  }
  for (const key of secrets) {
    const value = incoming[key];
    if ((value === undefined || value === SECRET_PLACEHOLDER) && previous[key] !== undefined)
      out[key] = previous[key];
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** `to` of an email channel as plain addresses (comma separated or a list), at most 20. */
export function emailRecipients(value: unknown): string[] | undefined {
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return list.length > 0 && list.length <= 20 && list.every(isEmailAddress) ? list : undefined;
}

export async function sendChannel(
  channel: { type: string; config: unknown },
  payload: { title: string; details?: unknown },
  fetchImpl: typeof fetch = fetch,
  policy: UrlPolicyOptions = {},
  mailer?: Mailer,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const config = asRecord(channel.config);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
      // Admin-entered URL: checked against the outbound policy (see alert-url.ts) before any
      // request, and redirects are not followed so a public host cannot bounce us inward.
      const allowed = await checkOutboundUrl(url, policy);
      if (!allowed.ok) return { ok: false as const, error: allowed.error };
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
      return response.ok
        ? { ok: true as const, status: response.status }
        : { ok: false as const, status: response.status, error: `HTTP ${String(response.status)}` };
    };
    if (channel.type === 'webhook') {
      if (typeof config.url !== 'string') return { ok: false, error: 'webhook url is missing' };
      const body = JSON.stringify({ type: 'test', title: payload.title, details: payload.details });
      const headers: Record<string, string> = {};
      if (typeof config.secret === 'string' && config.secret)
        headers['x-dirouter-signature'] =
          `sha256=${createHmac('sha256', config.secret).update(body).digest('hex')}`;
      return await post(config.url, body, headers);
    }
    if (channel.type === 'slack') {
      const url = typeof config.webhookUrl === 'string' ? config.webhookUrl : config.url;
      if (typeof url !== 'string') return { ok: false, error: 'slack webhookUrl is missing' };
      return await post(url, { text: payload.title });
    }
    if (channel.type === 'telegram') {
      if (typeof config.botToken !== 'string' || config.chatId === undefined)
        return { ok: false, error: 'telegram botToken/chatId is missing' };
      return await post(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        chat_id: config.chatId,
        text: payload.title,
      });
    }
    if (channel.type === 'email') {
      const to = emailRecipients(config.to);
      if (!to) return { ok: false, error: 'email channel needs valid recipient addresses (to)' };
      const url = typeof config.webhookUrl === 'string' ? config.webhookUrl : config.url;
      // An HTTP relay, when set, is kept; otherwise the message goes out over SMTP (card 24.2).
      if (typeof url === 'string')
        return await post(url, { to: config.to, subject: payload.title, text: payload.title });
      if (!mailer?.enabled) return { ok: false, error: 'SMTP is not configured (SMTP_URL)' };
      const sent = await mailer.send({
        to,
        subject: `[DiRouter] ${payload.title}`,
        text: payload.title,
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

@Injectable()
export class AlertsService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
  ) {}

  /** Every channel response goes through here: secrets never leave the service. */
  #channelView<T extends { type: string; config: unknown }>(row: T) {
    return { ...row, ...redactChannelConfig(row.type, row.config) };
  }

  /** URLs are checked when saved (syntax and scheme) and again, with DNS, when called. */
  #assertChannelConfig(config: Record<string, unknown>): void {
    const production = process.env.NODE_ENV === 'production';
    for (const key of URL_KEYS) {
      if (config[key] === undefined) continue;
      const check = checkUrlSyntax(config[key], production);
      if (!check.ok)
        throw new DiRouterError('invalid_request', {
          message: `config.${key}: ${check.error}`,
          status: 400,
        });
    }
    if (config.to !== undefined && !emailRecipients(config.to))
      throw new DiRouterError('invalid_request', {
        message: 'config.to: one or more email addresses, comma separated',
        status: 400,
      });
    if (Object.values(config).includes(SECRET_PLACEHOLDER))
      throw new DiRouterError('invalid_request', {
        message: `'${SECRET_PLACEHOLDER}' is a placeholder for a stored secret, not a value`,
        status: 400,
      });
  }

  #assertRule(rule: { type: string; threshold: unknown }): void {
    if (
      THRESHOLD_REQUIRED.has(rule.type) &&
      (rule.threshold === null || rule.threshold === undefined)
    )
      throw new DiRouterError('invalid_request', {
        message: `rule type '${rule.type}' requires a threshold`,
        status: 400,
      });
  }

  /**
   * The usage queue is shared by the whole deployment, so its length says nothing about one
   * tenant and is operator information: only the platform organization may alert on it.
   */
  async #assertRuleTypeAllowed(org: OrgContext, type: string): Promise<void> {
    if (type !== 'queue_length') return;
    const organization = await this.db.client.organization.findUnique({
      where: { id: org.organizationId },
      select: { isPlatform: true },
    });
    if (!organization?.isPlatform)
      throw new DiRouterError('forbidden', {
        message: "Rule type 'queue_length' is only available to the platform organization",
      });
  }

  /** Audit rows carry names and changed field names only, never channel config values. */
  async #audit(
    org: OrgContext,
    action: string,
    targetType: string,
    targetId: string,
    diff?: object,
  ) {
    await this.db.client.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: org.organizationId,
        actorUserId: org.userId,
        ...(org.ip ? { ip: org.ip } : {}),
        action,
        targetType,
        targetId,
        ...(diff ? { diff } : {}),
      },
    });
  }

  async listChannels(org: OrgContext) {
    const rows = await this.db.client.notificationChannel.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.#channelView(row));
  }

  async createChannel(org: OrgContext, input: ChannelInput) {
    const config = mergeChannelConfig(input.type, input.config ?? {}, { type: '', config: {} });
    this.#assertChannelConfig(config);
    const row = await this.db.client.notificationChannel.create({
      data: {
        id: prefixedId('chn'),
        organizationId: org.organizationId,
        name: input.name,
        type: input.type,
        config: config as never,
        enabled: input.enabled ?? true,
      },
    });
    await this.#audit(org, 'alert_channel.created', 'alert_channel', row.id, {
      name: row.name,
      type: row.type,
    });
    return this.#channelView(row);
  }

  async updateChannel(org: OrgContext, id: string, input: Partial<ChannelInput>) {
    const stored = await this.channelOwned(org, id);
    const type = input.type ?? stored.type;
    // A type change without a new config would leave the old type's secrets behind.
    const config =
      input.config !== undefined || type !== stored.type
        ? mergeChannelConfig(type, input.config ?? {}, stored)
        : undefined;
    if (config) this.#assertChannelConfig(config);
    const row = await this.db.client.notificationChannel.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(config !== undefined ? { config: config as never } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
    await this.#audit(org, 'alert_channel.updated', 'alert_channel', id, {
      fields: Object.keys(input),
    });
    return this.#channelView(row);
  }

  async removeChannel(org: OrgContext, id: string) {
    const stored = await this.channelOwned(org, id);
    await this.db.client.notificationChannel.delete({ where: { id } });
    await this.#audit(org, 'alert_channel.deleted', 'alert_channel', id, { name: stored.name });
  }

  async testChannel(org: OrgContext, id: string) {
    const channel = await this.channelOwned(org, id);
    // An email test goes to addresses the tenant chose, from the operator's address: only a person
    // whose own address is verified may send one (card 23.4).
    if (channel.type === 'email')
      await requireVerifiedEmail(
        this.db.client,
        org,
        'Verify your email address before sending test emails',
      );
    await this.#limitTest(org, channel.id);
    return sendChannel(channel, { title: TEST_ALERT_TITLE }, fetch, {}, this.mail.mailer);
  }

  /** Counters live in Valkey (shared by replicas); without Valkey no test is sent. */
  async #limitTest(org: OrgContext, channelId: string) {
    const valkey = this.valkey.client;
    const gapKey = `dirouter:alerts:test-gap:${channelId}`;
    const hourKey = `dirouter:alerts:test-hour:${org.organizationId}`;
    try {
      const gap = await valkey.set(gapKey, '1', 'EX', CHANNEL_TEST_LIMITS.channelGapSeconds, 'NX');
      if (gap !== 'OK') {
        const ttl = await valkey.pttl(gapKey);
        throw new RateLimitError({
          message: 'This channel was tested a moment ago; wait a minute',
          retryAfterMs: ttl > 0 ? ttl : CHANNEL_TEST_LIMITS.channelGapSeconds * 1000,
        });
      }
      const count = await valkey.incr(hourKey);
      if (count === 1) await valkey.expire(hourKey, 3_600);
      if (count > CHANNEL_TEST_LIMITS.orgPerHour) {
        const ttl = await valkey.pttl(hourKey);
        throw new RateLimitError({
          message: `At most ${String(CHANNEL_TEST_LIMITS.orgPerHour)} channel tests per hour; try again later`,
          retryAfterMs: ttl > 0 ? ttl : 3_600_000,
        });
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      throw new DiRouterError('service_unavailable', {
        message: 'Channel tests are unavailable right now; try again later',
      });
    }
  }

  listRules(org: OrgContext) {
    return this.db.client.alertRule.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createRule(org: OrgContext, input: RuleInput) {
    this.#assertRule({ type: input.type, threshold: input.threshold });
    await this.#assertRuleTypeAllowed(org, input.type);
    if (input.channelId) await this.channelOwned(org, input.channelId);
    const row = await this.db.client.alertRule.create({
      data: {
        id: prefixedId('alr'),
        organizationId: org.organizationId,
        name: input.name,
        type: input.type,
        threshold: input.threshold ?? null,
        windowMinutes: input.windowMinutes ?? 15,
        silenceMinutes: input.silenceMinutes ?? 60,
        channelId: input.channelId ?? null,
        enabled: input.enabled ?? true,
      },
    });
    await this.#audit(org, 'alert_rule.created', 'alert_rule', row.id, {
      name: row.name,
      type: row.type,
    });
    return row;
  }

  async updateRule(org: OrgContext, id: string, input: Partial<RuleInput>) {
    const stored = await this.ruleOwned(org, id);
    // Validate the rule as it will be stored, not just the patch.
    if (input.type !== undefined || input.threshold !== undefined)
      this.#assertRule({
        type: input.type ?? stored.type,
        threshold: input.threshold ?? stored.threshold,
      });
    if (input.type !== undefined) await this.#assertRuleTypeAllowed(org, input.type);
    if (input.channelId) await this.channelOwned(org, input.channelId);
    const row = await this.db.client.alertRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
        ...(input.windowMinutes !== undefined ? { windowMinutes: input.windowMinutes } : {}),
        ...(input.silenceMinutes !== undefined ? { silenceMinutes: input.silenceMinutes } : {}),
        ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
    await this.#audit(org, 'alert_rule.updated', 'alert_rule', id, { fields: Object.keys(input) });
    return row;
  }

  async removeRule(org: OrgContext, id: string) {
    const stored = await this.ruleOwned(org, id);
    await this.db.client.alertRule.delete({ where: { id } });
    await this.#audit(org, 'alert_rule.deleted', 'alert_rule', id, { name: stored.name });
  }

  async listEvents(org: OrgContext, limit: number, acknowledged?: boolean) {
    return this.db.client.alertEvent.findMany({
      where: {
        organizationId: org.organizationId,
        ...(acknowledged === undefined
          ? {}
          : acknowledged
            ? { acknowledgedAt: { not: null } }
            : { acknowledgedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async ackEvent(org: OrgContext, id: string) {
    const event = await this.db.client.alertEvent.findFirst({
      where: { id, organizationId: org.organizationId },
      select: { id: true },
    });
    if (!event) throw new DiRouterError('not_found', { message: 'event not found', status: 404 });
    return this.db.client.alertEvent.update({
      where: { id },
      data: { acknowledgedAt: new Date() },
    });
  }

  private async channelOwned(org: OrgContext, id: string) {
    const row = await this.db.client.notificationChannel.findFirst({
      where: { id, organizationId: org.organizationId },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'channel not found', status: 404 });
    return row;
  }

  private async ruleOwned(org: OrgContext, id: string) {
    const row = await this.db.client.alertRule.findFirst({
      where: { id, organizationId: org.organizationId },
      select: { id: true, name: true, type: true, threshold: true },
    });
    if (!row) throw new DiRouterError('not_found', { message: 'rule not found', status: 404 });
    return row;
  }
}
