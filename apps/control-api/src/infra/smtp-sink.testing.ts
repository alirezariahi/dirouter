/**
 * Test-only SMTP server (card 24.2): a real SMTP listener on a random local port that keeps every
 * message it accepts, so tests check what the mailer actually sent. Excluded from the build.
 */
import type { AddressInfo } from 'node:net';

import { SMTPServer } from 'smtp-server';

export interface SinkMessage {
  to: string[];
  raw: string;
}

export interface SmtpSink {
  url: string;
  messages: SinkMessage[];
  /** Messages to one address, newest last. */
  to(address: string): SinkMessage[];
  close(): Promise<void>;
}

/** Undoes quoted-printable soft line breaks and escapes, enough to read links in a body. */
export function decodeBody(raw: string): string {
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
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
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  return {
    url: `smtp://127.0.0.1:${String(port)}`,
    messages,
    to: (address) => messages.filter((m) => m.to.includes(address)),
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}
