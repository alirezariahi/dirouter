/** Pure helpers behind the Sprint 2 pages (cards 15.2, 16.1 to 16.5 and 17.1). */
import { describe, expect, it } from 'vitest';

import { formatUsd } from './s2-format';
import {
  channelConfig,
  channelFormOf,
  channelUpdateConfig,
  configOf,
  liveCounts,
  reconcile,
  ROLLUP_GRACE_MS,
  ruleProblem,
  settledWindow,
  DRILL,
  LIVE_REFRESH_MS,
  MAX_MODELS,
  median,
  metricValue,
  parseObject,
  reconciles,
  toggleModel,
} from './s2-helpers';

const draft = {
  type: 'regex',
  pattern: 'secret',
  flags: 'gi',
  terms: ' alpha, beta ,, ',
  piiType: 'email',
  maxTokens: '8000',
  schema: '{"type":"object"}',
};

describe('guardrail config', () => {
  it('builds the config each policy type expects', () => {
    expect(configOf(draft)).toEqual({ pattern: 'secret', flags: 'gi' });
    expect(configOf({ ...draft, flags: '' })).toEqual({ pattern: 'secret' });
    expect(configOf({ ...draft, type: 'keyword' })).toEqual({ terms: ['alpha', 'beta'] });
    expect(configOf({ ...draft, type: 'pii' })).toEqual({ type: 'email' });
    expect(configOf({ ...draft, type: 'max_input_tokens' })).toEqual({ maxTokens: 8000 });
    expect(configOf({ ...draft, type: 'json_schema' })).toEqual({ schema: { type: 'object' } });
    expect(configOf({ ...draft, type: 'secret' })).toEqual({});
  });

  it('throws on invalid JSON Schema text so nothing half-valid is sent', () => {
    expect(() => configOf({ ...draft, type: 'json_schema', schema: '{oops' })).toThrow();
  });
});

describe('cost reconciliation', () => {
  it('treats totals within a hundredth of a cent as equal', () => {
    expect(reconciles('12.34000000', '12.34000000')).toBe(true);
    expect(reconciles('12.34000000', '12.34005000')).toBe(true);
    expect(reconciles('12.34000000', '12.35000000')).toBe(false);
    expect(reconciles('0', '0')).toBe(true);
  });
});

describe('live view', () => {
  it('polls often enough for a sub-2-second display delay', () => {
    expect(LIVE_REFRESH_MS).toBeLessThanOrEqual(1_000);
  });

  it('computes the median latency', () => {
    expect(median([])).toBe(0);
    expect(median([30])).toBe(30);
    expect(median([10, 30, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
  });
});

describe('analytics', () => {
  const point = { requests: 10, errors: 2, costUsd: '1.50', inputTokens: 100, outputTokens: 50 };

  it('reads each metric from a series point', () => {
    expect(metricValue(point, 'requests')).toBe(10);
    expect(metricValue(point, 'errors')).toBe(2);
    expect(metricValue(point, 'cost')).toBe(1.5);
    expect(metricValue(point, 'tokens')).toBe(150);
    expect(metricValue({ requests: 1, errors: 0, costUsd: '0' }, 'tokens')).toBe(0);
  });

  it('every breakdown drills down to a Request Log filter', () => {
    expect(DRILL).toEqual({
      byModel: 'model',
      byKey: 'apiKeyId',
      byProject: 'projectId',
      byProvider: 'providerId',
    });
  });
});

describe('playground model selection', () => {
  it('toggles and never exceeds the limit', () => {
    expect(toggleModel([], 'a')).toEqual(['a']);
    expect(toggleModel(['a', 'b'], 'a')).toEqual(['b']);
    const full = Array.from({ length: MAX_MODELS }, (_, i) => `m${String(i)}`);
    expect(toggleModel(full, 'extra')).toEqual(full);
    expect(toggleModel(full, 'm0')).toHaveLength(MAX_MODELS - 1);
  });
});

describe('gateway settings editor', () => {
  it('accepts only JSON objects', () => {
    expect(parseObject('{"cache":{"exact":{"enabled":true}}}')).toEqual({
      cache: { exact: { enabled: true } },
    });
    expect(parseObject('{}')).toEqual({});
    expect(parseObject('[]')).toBeUndefined();
    expect(parseObject('null')).toBeUndefined();
    expect(parseObject('"x"')).toBeUndefined();
    expect(parseObject('{broken')).toBeUndefined();
  });
});

describe('alert channel config', () => {
  const form = {
    url: 'https://hooks.example.com/x',
    secret: 's3',
    botToken: 'bot',
    chatId: '42',
    to: 'ops@example.com',
  };

  it('matches the fields the worker reads for each channel type', () => {
    expect(channelConfig('webhook', form)).toEqual({ url: form.url, secret: 's3' });
    expect(channelConfig('webhook', { ...form, secret: '' })).toEqual({ url: form.url });
    expect(channelConfig('slack', form)).toEqual({ webhookUrl: form.url });
    expect(channelConfig('telegram', form)).toEqual({ botToken: 'bot', chatId: '42' });
    expect(channelConfig('email', form)).toEqual({ webhookUrl: form.url, to: 'ops@example.com' });
    // Without a relay URL the worker sends over SMTP (card 24.2).
    expect(channelConfig('email', { ...form, url: '' })).toEqual({ to: 'ops@example.com' });
  });
});

describe('alert channel update', () => {
  const blank = { url: '', secret: '', botToken: '', chatId: '', to: '' };

  it('starts the edit form with masked secrets blank and plain values shown', () => {
    expect(channelFormOf('webhook', { url: 'https://hooks.example.com/x', secret: '***' })).toEqual(
      { ...blank, url: 'https://hooks.example.com/x' },
    );
    expect(channelFormOf('slack', { webhookUrl: '***' })).toEqual(blank);
    expect(channelFormOf('telegram', { botToken: '***', chatId: '42' })).toEqual({
      ...blank,
      chatId: '42',
    });
    expect(channelFormOf('email', null)).toEqual(blank);
  });

  it('omits secrets that were not retyped so the stored value is kept', () => {
    const form = channelFormOf('webhook', { url: 'https://a.example.com', secret: '***' });
    expect(channelUpdateConfig('webhook', form)).toEqual({ url: 'https://a.example.com' });
    expect(channelUpdateConfig('slack', blank)).toEqual({});
    expect(channelUpdateConfig('telegram', { ...blank, chatId: '42' })).toEqual({ chatId: '42' });
    expect(channelUpdateConfig('email', { ...blank, to: 'ops@example.com' })).toEqual({
      to: 'ops@example.com',
    });
  });

  it('never posts the mask back, sends retyped secrets and clears on request', () => {
    expect(
      channelUpdateConfig('webhook', { ...blank, url: 'https://a.example.com', secret: '***' }),
    ).toEqual({ url: 'https://a.example.com' });
    expect(channelUpdateConfig('telegram', { ...blank, botToken: ' new ', chatId: '42' })).toEqual({
      botToken: 'new',
      chatId: '42',
    });
    expect(
      channelUpdateConfig('webhook', { ...blank, url: 'https://a.example.com' }, ['secret']),
    ).toEqual({ url: 'https://a.example.com', secret: '' });
  });
});

describe('alert rule validation', () => {
  it('requires a threshold for the types that cannot fire without one', () => {
    for (const type of ['error_rate', 'latency', 'budget'])
      expect(ruleProblem({ type, threshold: ' ' })).toBe('thresholdRequired');
    expect(ruleProblem({ type: 'invalid_credential', threshold: '' })).toBeUndefined();
    expect(ruleProblem({ type: 'latency', threshold: '0' })).toBeUndefined();
    expect(ruleProblem({ type: 'latency', threshold: '-1' })).toBe('thresholdInvalid');
    expect(ruleProblem({ type: 'latency', threshold: 'abc' })).toBe('thresholdInvalid');
  });

  it('refuses the rule types the API no longer accepts', () => {
    // Evaluated by the worker since card 24.2: breaker_open counts, queue_length needs a threshold.
    expect(ruleProblem({ type: 'breaker_open', threshold: '' })).toBeUndefined();
    expect(ruleProblem({ type: 'queue_length', threshold: '' })).toBe('thresholdRequired');
    expect(ruleProblem({ type: 'queue_length', threshold: '500' })).toBeUndefined();
    expect(ruleProblem({ type: 'something_else', threshold: '1' })).toBe('typeUnsupported');
  });
});

describe('cost comparison window', () => {
  const HOUR = 3_600_000;
  const now = Date.parse('2026-11-20T10:30:00Z');

  it('ends an hourly range at the last closed hour', () => {
    const w = settledWindow('2026-11-19T11:00:00Z', '2026-11-20T11:00:00Z', now);
    expect(w).toEqual({
      to: '2026-11-20T10:00:00.000Z',
      boundary: '2026-11-20T10:00:00.000Z',
      granularity: 'hour',
    });
  });

  it('waits for the grace period after an hour closes', () => {
    const justAfter = Date.parse('2026-11-20T10:00:30Z');
    expect(settledWindow('2026-11-19T10:00:00Z', '2026-11-20T11:00:00Z', justAfter)?.to).toBe(
      '2026-11-20T09:00:00.000Z',
    );
    const later = Date.parse('2026-11-20T10:00:00Z') + ROLLUP_GRACE_MS;
    expect(settledWindow('2026-11-19T10:00:00Z', '2026-11-20T11:00:00Z', later)?.to).toBe(
      '2026-11-20T10:00:00.000Z',
    );
  });

  it('ends a daily range (over 7 days) at the last millisecond of the previous UTC day', () => {
    const w = settledWindow('2026-10-21T11:00:00Z', '2026-11-20T11:00:00Z', now);
    expect(w).toEqual({
      to: '2026-11-19T23:59:59.999Z',
      boundary: '2026-11-20T00:00:00.000Z',
      granularity: 'day',
    });
  });

  it('never extends past the requested range and gives up without a closed bucket', () => {
    const past = settledWindow('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', now);
    expect(past?.to).toBe('2026-11-02T00:00:00.000Z');
    expect(
      settledWindow('2026-11-20T10:00:00Z', '2026-11-20T11:00:00Z', now + 10 * 60_000),
    ).toBeUndefined();
    expect(settledWindow('2026-11-20T11:00:00Z', '2026-11-20T10:00:00Z', now)).toBeUndefined();
    expect(settledWindow('nope', '2026-11-20T10:00:00Z', now)).toBeUndefined();
    // 8 days: the closed part must still be longer than 7 days to stay on the daily table.
    expect(settledWindow('2026-11-12T11:00:00Z', '2026-11-20T11:00:00Z', now)).toBeDefined();
    expect(
      settledWindow('2026-11-13T10:00:00Z', '2026-11-20T10:00:01Z', now - HOUR),
    ).toBeUndefined();
  });

  it('reports the live tail as pending instead of a mismatch', () => {
    expect(reconcile({ rollupUsd: '12.5', ledgerUsd: '12.50000000' }, '12.9')).toEqual({
      matches: true,
      diffUsd: 0,
      pendingUsd: expect.closeTo(0.4, 10) as number,
    });
    const off = reconcile({ rollupUsd: '12.5', ledgerUsd: '12.6' }, '12.6');
    expect(off.matches).toBe(false);
    expect(off.diffUsd).toBeCloseTo(0.1, 10);
    expect(off.pendingUsd).toBe(0);
    expect(reconcile({ rollupUsd: '1', ledgerUsd: '1' }, '0.5').pendingUsd).toBe(0);
  });
});

describe('tiny amounts', () => {
  const plain = (value: string) => value.replace(/\u200e/g, '');

  it('keeps cents for dollars and four decimals below a dollar', () => {
    expect(formatUsd(0, 'en')).toBe('$0.00');
    expect(formatUsd('12.3456', 'en')).toBe('$12.35');
    expect(formatUsd(0.1234567, 'en')).toBe('$0.1235');
    expect(formatUsd(0.00005, 'en')).toBe('$0.0001');
    expect(formatUsd('not a number', 'en')).toBe('$0.00');
  });

  it('shows significant digits for tiny non-zero amounts instead of $0.00', () => {
    expect(formatUsd(0.000012, 'en')).toBe('$0.000012');
    expect(formatUsd('0.00004999', 'en')).toBe('$0.00005');
    expect(formatUsd(-0.000012, 'en')).toBe('-$0.000012');
    expect(plain(formatUsd(0.0000001, 'en'))).toBe('<$0.000001');
  });

  it('applies the same rules in Persian', () => {
    expect(plain(formatUsd(0.000012, 'fa'))).toContain('۰٫۰۰۰۰۱۲');
    expect(plain(formatUsd(0.0000001, 'fa'))).toMatch(/^<.*۰٫۰۰۰۰۰۱/);
    expect(plain(formatUsd(0, 'fa'))).toContain('۰٫۰۰');
  });
});

describe('live counters', () => {
  const now = Date.parse('2026-11-20T10:00:00Z');
  const row = (secondsAgo: number, status = 'success') => ({
    createdAt: new Date(now - secondsAgo * 1000).toISOString(),
    status,
  });

  it('counts within the fetched rows', () => {
    expect(liveCounts([row(5), row(30, 'error'), row(90)], now)).toEqual({
      sample: 3,
      lastMinute: 2,
      errors: 1,
      saturated: false,
    });
  });

  it('flags a full page of last-minute rows as a lower bound', () => {
    const page = Array.from({ length: 50 }, (_, i) => row(i));
    expect(liveCounts(page, now)).toMatchObject({ lastMinute: 50, saturated: true });
    expect(liveCounts([...page.slice(1), row(120)], now).saturated).toBe(false);
  });
});
