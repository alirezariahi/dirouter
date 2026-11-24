import type { AddressInfo } from 'node:net';

import { generate } from 'selfsigned';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMailer, isEmailAddress, parseSmtpUrl } from './mail.js';

interface Received {
  from: string | undefined;
  to: string[];
  raw: string;
  secure: boolean;
  user: string | undefined;
}

/** A real SMTP server on a random local port, recording every accepted message. */
async function fakeSmtp(options: Partial<SMTPServerOptions> = {}) {
  const received: Received[] = [];
  const server = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === 'mailer' && auth.password === 'p@ss word')
        callback(null, { user: auth.username });
      else callback(new Error('bad credentials'));
    },
    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
          secure: session.secure,
          user: typeof session.user === 'string' ? session.user : undefined,
        });
        callback();
      });
    },
    ...options,
  });
  // A refused TLS handshake is reported here; the client side is what the tests check.
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  servers.push(server);
  return { port, received };
}

const servers: SMTPServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((done) => {
          s.close(() => {
            done();
          });
        }),
    ),
  );
});

let tls: { key: string; cert: string };
beforeAll(async () => {
  const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
  tls = { key: pems.private, cert: pems.cert };
});

const message = { to: 'ops@example.com', subject: 'Breaker open', text: 'provider is down' };

describe('parseSmtpUrl', () => {
  it('reads host, port, credentials and the TLS mode', () => {
    expect(parseSmtpUrl('smtps://u%40x:p%3Aw@mail.example.com')).toEqual({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      startTls: 'off',
      auth: { user: 'u@x', pass: 'p:w' },
    });
    expect(parseSmtpUrl('smtp://mailpit:1025')).toMatchObject({
      port: 1025,
      secure: false,
      startTls: 'optional',
    });
    expect(parseSmtpUrl('smtp://mail.example.com', true)).toMatchObject({
      port: 587,
      startTls: 'required',
    });
    expect(parseSmtpUrl('smtp://relay:25?starttls=off', true).startTls).toBe('off');
  });

  it('refuses anything else without echoing the URL', () => {
    expect(() => parseSmtpUrl('http://x')).toThrow('smtp:// or smtps://');
    expect(() => parseSmtpUrl('not a url')).toThrow('not a valid URL');
    expect(() => parseSmtpUrl('smtp://u:secret@x?starttls=maybe')).toThrow(/^((?!secret).)*$/);
  });
});

describe('createMailer', () => {
  it('is disabled without a URL and says so', async () => {
    const mailer = createMailer({ url: '', from: 'a@b.c' });
    expect(mailer.enabled).toBe(false);
    expect(await mailer.send(message)).toEqual({
      ok: false,
      error: 'SMTP is not configured (SMTP_URL)',
    });
  });

  it('delivers over plain SMTP with authentication (development mail server)', async () => {
    const smtp = await fakeSmtp({ disabledCommands: ['STARTTLS'] });
    const mailer = createMailer({
      url: `smtp://mailer:p%40ss%20word@127.0.0.1:${String(smtp.port)}`,
      from: 'DiRouter <noreply@dirouter.test>',
      production: false,
    });
    const sent = await mailer.send(message);
    mailer.close();
    expect(sent.ok).toBe(true);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]).toMatchObject({
      from: 'noreply@dirouter.test',
      to: ['ops@example.com'],
      secure: false,
      user: 'mailer',
    });
    expect(smtp.received[0]?.raw).toContain('Subject: Breaker open');
    expect(smtp.received[0]?.raw).toContain('provider is down');
  });

  it('delivers with implicit TLS (smtps://) and verifies the certificate', async () => {
    const smtp = await fakeSmtp({ secure: true, ...tls });
    const mailer = createMailer({
      url: `smtps://127.0.0.1:${String(smtp.port)}`,
      from: 'noreply@dirouter.test',
      ca: tls.cert,
    });
    expect((await mailer.send(message)).ok).toBe(true);
    mailer.close();
    expect(smtp.received[0]?.secure).toBe(true);
  });

  it('upgrades with STARTTLS when required', async () => {
    const smtp = await fakeSmtp({ ...tls });
    const mailer = createMailer({
      url: `smtp://mailer:p%40ss%20word@127.0.0.1:${String(smtp.port)}?starttls=required`,
      from: 'noreply@dirouter.test',
      ca: tls.cert,
    });
    expect((await mailer.send(message)).ok).toBe(true);
    mailer.close();
    expect(smtp.received[0]).toMatchObject({ secure: true, user: 'mailer' });
  });

  it('refuses to send in clear text when STARTTLS is required (the production default)', async () => {
    const smtp = await fakeSmtp({ hideSTARTTLS: true });
    const mailer = createMailer({
      url: `smtp://127.0.0.1:${String(smtp.port)}`,
      from: 'noreply@dirouter.test',
      production: true,
    });
    const sent = await mailer.send(message);
    mailer.close();
    expect(sent.ok).toBe(false);
    expect(smtp.received).toHaveLength(0);
  });

  it('refuses an untrusted certificate', async () => {
    const smtp = await fakeSmtp({ secure: true, ...tls });
    const mailer = createMailer({
      url: `smtps://127.0.0.1:${String(smtp.port)}`,
      from: 'noreply@dirouter.test',
    });
    const sent = await mailer.send(message);
    mailer.close();
    expect(sent.ok).toBe(false);
    expect(smtp.received).toHaveLength(0);
  });

  it('rejects malformed recipients before connecting', async () => {
    const mailer = createMailer({ url: 'smtp://127.0.0.1:1', from: 'noreply@dirouter.test' });
    expect(await mailer.send({ ...message, to: 'a@b.c\r\nBcc: x@y.z' })).toEqual({
      ok: false,
      error: 'invalid recipient address',
    });
    expect(await mailer.send({ ...message, to: [] })).toMatchObject({ ok: false });
    mailer.close();
    expect(isEmailAddress('ops@example.com')).toBe(true);
    expect(isEmailAddress('Ops <ops@example.com>')).toBe(false);
  });
});
