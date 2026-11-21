import { describe, expect, it } from 'vitest';

import {
  type AlertDb,
  type AlertEventRow,
  type AlertRuleRow,
  type ChannelRow,
  checkOutboundUrl,
  dedupKeyFor,
  deliver,
  evaluateAlerts,
  isBlockedAddress,
  MAX_DELIVERY_ATTEMPTS,
  sendTestMessage,
  signWebhook,
  thresholdOf,
} from './alerts.js';

/** Request bodies in these tests are always JSON strings. */
const bodyText = (init: RequestInit): string => (typeof init.body === 'string' ? init.body : '');

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

const rule = (over: Partial<AlertRuleRow> = {}): AlertRuleRow => ({
  id: 'r1',
  organizationId: 'org',
  name: 'High errors',
  type: 'error_rate',
  threshold: 5,
  windowMinutes: 15,
  silenceMinutes: 60,
  channelId: 'c1',
  enabled: true,
  ...over,
});

const channel = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: 'c1',
  organizationId: 'org',
  name: 'ops',
  type: 'webhook',
  config: { url: 'https://hooks.test/alert', secret: 's3cret' },
  enabled: true,
  ...over,
});

function fakeDb(options: {
  rules: AlertRuleRow[];
  measure: Array<{
    total?: number;
    errors?: number;
    p95?: number | null;
    spent?: number;
    failures?: number;
  }>;
  recent?: AlertEventRow | null;
  channels?: ChannelRow[];
}) {
  const created: Record<string, unknown>[] = [];
  const updated: { where: { id: string }; data: Record<string, unknown> }[] = [];
  let call = 0;
  const db: AlertDb = {
    $queryRawUnsafe: (async () => {
      const row = options.measure[call] ?? {};
      call += 1;
      return [row];
    }) as AlertDb['$queryRawUnsafe'],
    alertRule: { findMany: async () => options.rules },
    alertEvent: {
      findFirst: async () => options.recent ?? null,
      create: async ({ data }) => {
        created.push(data);
        return {
          id: String(data.id),
          organizationId: 'org',
          ruleId: String(data.ruleId),
          severity: 'warning',
          title: String(data.title),
          details: data.details,
          dedupKey: (data.dedupKey as string | null) ?? null,
          deliveredAt: null,
          deliveryError: null,
        };
      },
      update: async (args) => {
        updated.push(args);
        return {};
      },
    },
    notificationChannel: {
      findUnique: async ({ where }) => options.channels?.find((c) => c.id === where.id) ?? null,
    },
  };
  return { db, created, updated };
}

describe('alert evaluation (16.2)', () => {
  it('fires when the error rate crosses the threshold and delivers a signed webhook', async () => {
    const { db, created, updated } = fakeDb({
      rules: [rule()],
      measure: [{ total: 100, errors: 9 }],
      channels: [channel()],
    });
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: bodyText(init),
        headers: init.headers as Record<string, string>,
      });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await evaluateAlerts({
      db,
      logger,
      clock: { now: () => 1_000_000 },
      fetchImpl,
    });

    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.value).toBe(9);
    expect(created).toHaveLength(1);
    // One key per silence window (60 minutes), not per millisecond.
    expect(created[0]?.dedupKey).toBe('r1:0');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hooks.test/alert');
    expect(calls[0]?.headers['x-dirouter-signature']).toBe(signWebhook(calls[0]!.body, 's3cret'));
    expect(updated[0]?.data.deliveredAt).toBeInstanceOf(Date);
  });

  it('does not notify again inside the silence window', async () => {
    const recent: AlertEventRow = {
      id: 'old',
      organizationId: 'org',
      ruleId: 'r1',
      severity: 'warning',
      title: 'old',
      details: {},
      dedupKey: 'r1:1',
      deliveredAt: null,
      deliveryError: null,
    };
    const { db, created } = fakeDb({
      rules: [rule()],
      measure: [{ total: 100, errors: 50 }],
      recent,
      channels: [channel()],
    });
    const result = await evaluateAlerts({
      db,
      logger,
      clock: { now: () => 1_000_000 },
      fetchImpl: async () => new Response('ok'),
    });
    expect(result.fired).toHaveLength(0);
    expect(result.silenced).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('records delivery failures without throwing', async () => {
    const { db, updated } = fakeDb({
      rules: [rule()],
      measure: [{ total: 10, errors: 10 }],
      channels: [channel({ config: { url: 'https://hooks.test/down' } })],
    });
    const result = await evaluateAlerts({
      db,
      logger,
      clock: { now: () => 1_000_000 },
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });
    expect(result.fired[0]?.delivery).toEqual({ ok: false, error: 'HTTP 500' });
    expect(updated[0]?.data.deliveryError).toBe('HTTP 500');
  });

  it('measures latency and budget without fabricating data', async () => {
    const latency = fakeDb({
      rules: [rule({ id: 'r2', type: 'latency', threshold: 2_000 })],
      measure: [{ p95: 2_500 }],
    });
    const r1 = await evaluateAlerts({ db: latency.db, logger, clock: { now: () => 1 } });
    expect(r1.fired[0]?.value).toBe(2_500);

    const budget = fakeDb({
      rules: [rule({ id: 'r3', type: 'budget', threshold: 10 })],
      measure: [{ spent: 12.5 }],
    });
    const r2 = await evaluateAlerts({ db: budget.db, logger, clock: { now: () => 1 } });
    expect(r2.fired[0]?.value).toBe(12.5);
  });

  it('skips rules whose data is not available instead of inventing a value', async () => {
    const { db } = fakeDb({
      rules: [rule({ id: 'r4', type: 'breaker_open', threshold: 1 })],
      measure: [{}],
    });
    const result = await evaluateAlerts({ db, logger, clock: { now: () => 1 } });
    expect(result.fired).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ ruleId: 'r4', reason: 'no_persisted_breaker_state' });
  });
});

describe('dedup key and threshold (16.2)', () => {
  it('is stable inside one silence window and changes in the next', () => {
    const silenceMs = 60 * 60_000;
    expect(dedupKeyFor('r1', 0, silenceMs)).toBe('r1:0');
    expect(dedupKeyFor('r1', silenceMs - 1, silenceMs)).toBe('r1:0');
    expect(dedupKeyFor('r1', silenceMs, silenceMs)).toBe('r1:1');
    expect(dedupKeyFor('r1', 1_700_000_000_000, silenceMs)).toBe(
      dedupKeyFor('r1', 1_700_000_000_000 + 30_000, silenceMs),
    );
  });

  it('never reads a missing threshold as zero', () => {
    expect(thresholdOf({ type: 'budget', threshold: null })).toBeUndefined();
    expect(thresholdOf({ type: 'error_rate', threshold: undefined })).toBeUndefined();
    expect(thresholdOf({ type: 'latency', threshold: 'abc' })).toBeUndefined();
    expect(thresholdOf({ type: 'budget', threshold: '12.5' })).toBe(12.5);
    expect(thresholdOf({ type: 'budget', threshold: 0 })).toBe(0);
    // Counting rule: one failure is the natural default.
    expect(thresholdOf({ type: 'invalid_credential', threshold: null })).toBe(1);
  });

  it('skips a budget rule without a threshold instead of firing on zero spend', async () => {
    const { db, created } = fakeDb({
      rules: [rule({ id: 'r5', type: 'budget', threshold: null })],
      measure: [{ spent: 0 }],
    });
    const result = await evaluateAlerts({ db, logger, clock: { now: () => 1 } });
    expect(created).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ ruleId: 'r5', reason: 'no_threshold' });
  });
});

describe('delivery retries (16.2)', () => {
  const failed = (over: Partial<AlertEventRow> = {}): AlertEventRow => ({
    id: 'ev1',
    organizationId: 'org',
    ruleId: 'r1',
    severity: 'warning',
    title: 'High errors',
    details: { type: 'error_rate' },
    dedupKey: 'r1:0',
    deliveredAt: null,
    deliveryError: 'HTTP 500',
    ...over,
  });

  it('retries a failed delivery on the next tick instead of silencing the rule', async () => {
    const { db, created, updated } = fakeDb({
      rules: [rule()],
      measure: [],
      recent: failed(),
      channels: [channel()],
    });
    const result = await evaluateAlerts({
      db,
      logger,
      clock: { now: () => 1_000_000 },
      fetchImpl: async () => new Response('ok'),
    });
    expect(created).toHaveLength(0);
    expect(result.silenced).toBe(0);
    expect(result.retried).toEqual([{ ruleId: 'r1', eventId: 'ev1', ok: true }]);
    expect(updated[0]?.where.id).toBe('ev1');
    expect(updated[0]?.data.deliveredAt).toBeInstanceOf(Date);
    expect(updated[0]?.data.deliveryError).toBeNull();
    expect(updated[0]?.data.details).toMatchObject({ deliveryAttempts: 2 });
  });

  it('stops retrying after the attempt limit and once it was delivered', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const exhausted = fakeDb({
      rules: [rule()],
      measure: [],
      recent: failed({ details: { deliveryAttempts: MAX_DELIVERY_ATTEMPTS } }),
      channels: [channel()],
    });
    const r1 = await evaluateAlerts({ db: exhausted.db, logger, fetchImpl });
    expect(r1.silenced).toBe(1);
    expect(r1.retried).toHaveLength(0);

    const delivered = fakeDb({
      rules: [rule()],
      measure: [],
      recent: failed({ deliveredAt: new Date(), deliveryError: null }),
      channels: [channel()],
    });
    const r2 = await evaluateAlerts({ db: delivered.db, logger, fetchImpl });
    expect(r2.silenced).toBe(1);
    expect(calls).toBe(0);
  });

  it('does not deliver to a channel of another organization', async () => {
    const { db } = fakeDb({
      rules: [rule()],
      measure: [{ total: 10, errors: 10 }],
      channels: [channel({ organizationId: 'other' })],
    });
    let called = false;
    const result = await evaluateAlerts({
      db,
      logger,
      clock: { now: () => 1 },
      fetchImpl: async () => {
        called = true;
        return new Response('ok');
      },
    });
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]?.delivery).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('outbound URL policy (16.2)', () => {
  it('classifies private and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '192.168.0.1',
      '169.254.169.254',
      '::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
    ])
      expect(isBlockedAddress(address), address).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('allows private hosts in development and blocks them in production', async () => {
    expect(await checkOutboundUrl('http://mailpit:8025/x', { production: false })).toEqual({
      ok: true,
    });
    expect((await checkOutboundUrl('file:///etc/passwd', { production: false })).ok).toBe(false);
    expect((await checkOutboundUrl('http://h.example/x', { production: true })).ok).toBe(false);
    const privateLookup = async () => [{ address: '8.8.8.8' }, { address: '172.16.3.4' }];
    expect(
      (await checkOutboundUrl('https://h.example/x', { production: true, lookup: privateLookup }))
        .ok,
    ).toBe(false);
    expect((await checkOutboundUrl('https://[::1]/x', { production: true })).ok).toBe(false);
    expect(
      await checkOutboundUrl('https://h.example/x', {
        production: true,
        lookup: async () => [{ address: '8.8.8.8' }],
      }),
    ).toEqual({ ok: true });
  });

  it('never calls a blocked URL', async () => {
    let called = false;
    const result = await deliver(
      channel({ config: { url: 'https://169.254.169.254/latest' } }),
      { title: 't', details: {} },
      {
        urlPolicy: { production: true },
        fetchImpl: (async () => {
          called = true;
          return new Response('ok');
        }) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({
      ok: false,
      error: 'url host resolves to a private or reserved address',
    });
    expect(called).toBe(false);
  });
});

describe('notification channels (16.2)', () => {
  it('formats slack messages', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(bodyText(init));
      return new Response('ok');
    }) as unknown as typeof fetch;
    const result = await deliver(
      channel({ type: 'slack', config: { webhookUrl: 'https://slack.test/hook' } }),
      { title: 'High errors', details: { windowMinutes: 15 } },
      { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(calls[0]).toContain('High errors');
  });

  it('uses the Telegram Bot API and reports missing config honestly', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response('ok');
    }) as unknown as typeof fetch;
    const ok = await deliver(
      channel({ type: 'telegram', config: { botToken: '123:abc', chatId: '42' } }),
      { title: 't', details: {} },
      { fetchImpl },
    );
    expect(ok.ok).toBe(true);
    expect(urls[0]).toBe('https://api.telegram.org/bot123:abc/sendMessage');

    const missing = await deliver(
      channel({ type: 'telegram', config: {} }),
      { title: 't', details: {} },
      { fetchImpl },
    );
    expect(missing).toEqual({ ok: false, error: 'telegram botToken/chatId is missing' });
  });

  it('refuses email without an HTTP relay (no fake SMTP)', async () => {
    const result = await deliver(channel({ type: 'email', config: { to: 'ops@example.com' } }), {
      title: 't',
      details: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('SMTP is not implemented');
  });

  it('sends a test message through the same delivery path', async () => {
    let body = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = bodyText(init);
      return new Response('ok');
    }) as unknown as typeof fetch;
    const result = await sendTestMessage(channel(), { fetchImpl, now: 5 });
    expect(result.ok).toBe(true);
    expect(body).toContain('Test message');
  });
});
