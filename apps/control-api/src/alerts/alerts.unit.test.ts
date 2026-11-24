/** Alert channels (card 16.2): secret redaction, keep-on-update and the outbound URL policy. */
import type { AddressInfo } from 'node:net';

import { createMailer } from '@dirouter/shared/mail';
import { SMTPServer } from 'smtp-server';
import { describe, expect, it } from 'vitest';

import { checkOutboundUrl, checkUrlSyntax, isBlockedAddress } from './alert-url.js';
import { RuleCreate } from './alerts.controller.js';
import {
  emailRecipients,
  mergeChannelConfig,
  redactChannelConfig,
  SECRET_PLACEHOLDER,
  sendChannel,
} from './alerts.service.js';

describe('channel secrets', () => {
  it('never returns a secret and names the ones that are set', () => {
    const webhook = redactChannelConfig('webhook', { url: 'https://h.example/x', secret: 's3' });
    expect(webhook).toEqual({
      config: { url: 'https://h.example/x', secret: SECRET_PLACEHOLDER },
      secretFields: ['secret'],
      hasSecret: true,
    });
    const slack = redactChannelConfig('slack', { webhookUrl: 'https://hooks.slack.com/T/B/x' });
    expect(slack.config.webhookUrl).toBe(SECRET_PLACEHOLDER);
    const telegram = redactChannelConfig('telegram', { botToken: '1:abc', chatId: '42' });
    expect(telegram.config).toEqual({ botToken: SECRET_PLACEHOLDER, chatId: '42' });
    expect(redactChannelConfig('webhook', { url: 'https://h.example' }).hasSecret).toBe(false);
  });

  it('keeps the stored secret when it is omitted or sent back as the placeholder', () => {
    const stored = { type: 'webhook', config: { url: 'https://old.example', secret: 's3' } };
    expect(mergeChannelConfig('webhook', { url: 'https://new.example' }, stored)).toEqual({
      url: 'https://new.example',
      secret: 's3',
    });
    expect(
      mergeChannelConfig(
        'webhook',
        { url: 'https://new.example', secret: SECRET_PLACEHOLDER },
        stored,
      ),
    ).toEqual({ url: 'https://new.example', secret: 's3' });
  });

  it('replaces or removes a secret explicitly, and drops it when the type changes', () => {
    const stored = { type: 'webhook', config: { url: 'https://old.example', secret: 's3' } };
    expect(mergeChannelConfig('webhook', { secret: 'new' }, stored)).toEqual({ secret: 'new' });
    expect(
      mergeChannelConfig('webhook', { url: 'https://x.example', secret: null }, stored),
    ).toEqual({
      url: 'https://x.example',
    });
    expect(
      mergeChannelConfig('telegram', { chatId: '1', botToken: SECRET_PLACEHOLDER }, stored),
    ).toEqual({
      chatId: '1',
    });
  });
});

describe('outbound URL policy', () => {
  it('classifies private, loopback, link-local and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00:ec2::254',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'not-an-ip',
    ])
      expect(isBlockedAddress(address), address).toBe(true);
    for (const address of ['8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
      expect(isBlockedAddress(address), address).toBe(false);
  });

  it('requires an http(s) URL without credentials, and https in production', () => {
    expect(checkUrlSyntax('ftp://h.example', false).ok).toBe(false);
    expect(checkUrlSyntax('file:///etc/passwd', false).ok).toBe(false);
    expect(checkUrlSyntax('not a url', false).ok).toBe(false);
    expect(checkUrlSyntax('https://user:pw@h.example', false).ok).toBe(false);
    expect(checkUrlSyntax('http://mailpit:8025/hook', false).ok).toBe(true);
    expect(checkUrlSyntax('http://h.example/hook', true).ok).toBe(false);
  });

  it('allows private hosts in development without resolving them', async () => {
    const lookup = async () => {
      throw new Error('must not resolve');
    };
    expect(
      await checkOutboundUrl('http://127.0.0.1:8025/x', { production: false, lookup }),
    ).toEqual({
      ok: true,
    });
  });

  it('blocks a production URL when any resolved address is private', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }];
    expect((await checkOutboundUrl('https://h.example/x', { production: true, lookup })).ok).toBe(
      false,
    );
    for (const url of [
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://127.0.0.1/x',
    ])
      expect((await checkOutboundUrl(url, { production: true })).ok, url).toBe(false);
    expect(
      await checkOutboundUrl('https://h.example/x', {
        production: true,
        lookup: async () => [{ address: '93.184.216.34' }],
      }),
    ).toEqual({ ok: true });
  });

  it('does not call a blocked URL from the test endpoint path', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof fetch;
    const result = await sendChannel(
      { type: 'webhook', config: { url: 'https://10.0.0.1/hook' } },
      { title: 't' },
      fetchImpl,
      { production: true },
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('rule types and the email channel over SMTP (24.2)', () => {
  it('accepts breaker_open (threshold defaults to one) and queue_length with a threshold', () => {
    expect(RuleCreate.safeParse({ name: 'b', type: 'breaker_open' }).success).toBe(true);
    expect(RuleCreate.safeParse({ name: 'q', type: 'queue_length', threshold: 500 }).success).toBe(
      true,
    );
    const missing = RuleCreate.safeParse({ name: 'q', type: 'queue_length' });
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error)).toContain('requires a threshold');
  });

  it('sends the channel test message over SMTP when there is no HTTP relay', async () => {
    const messages: { to: string[]; raw: string }[] = [];
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onData(stream, session, callback) {
        let raw = '';
        stream.on('data', (chunk: Buffer) => (raw += chunk.toString()));
        stream.on('end', () => {
          messages.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.server.address() as AddressInfo;
    const mailer = createMailer({
      url: `smtp://127.0.0.1:${String(port)}`,
      from: 'alerts@dirouter.test',
      production: false,
    });
    try {
      const result = await sendChannel(
        { type: 'email', config: { to: 'ops@example.com' } },
        { title: 'Test alert from DiRouter (ops)' },
        fetch,
        {},
        mailer,
      );
      expect(result).toEqual({ ok: true });
      expect(messages[0]?.to).toEqual(['ops@example.com']);
      expect(messages[0]?.raw).toContain('Subject: [DiRouter] Test alert from DiRouter (ops)');
    } finally {
      mailer.close();
      await new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      });
    }
  });

  it('explains a missing SMTP configuration and rejects bad recipients', async () => {
    const disabled = createMailer({ url: '', from: 'a@b.test' });
    const email = (to: string) =>
      sendChannel({ type: 'email', config: { to } }, { title: 't' }, fetch, {}, disabled);
    expect(await email('ops@example.com')).toEqual({
      ok: false,
      error: 'SMTP is not configured (SMTP_URL)',
    });
    expect((await email('nobody')).error).toContain('recipient');
    expect(emailRecipients('a@example.com,b@example.com')).toHaveLength(2);
  });
});
