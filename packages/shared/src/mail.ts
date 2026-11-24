/**
 * Outgoing email over SMTP (card 24.2): one mailer for alert notifications (worker) and
 * transactional mail such as invitations and email verification (control-api).
 *
 * Configured with one URL:
 * - `smtps://user:pass@host:465` connects with TLS from the first byte (implicit TLS);
 * - `smtp://user:pass@host:587` upgrades with STARTTLS. `?starttls=required` refuses a server
 *   that does not offer it, `?starttls=optional` uses it when offered, `?starttls=off` never does.
 *   In production the default is `required`, elsewhere `optional` (the dev mail server has no TLS).
 *
 * Certificates are always verified. Imported through `@dirouter/shared/mail`, so services that
 * never send mail (the gateway) do not load nodemailer.
 */
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string | readonly string[];
  subject: string;
  text: string;
  html?: string | undefined;
}

export type MailResult = { ok: true; messageId: string } | { ok: false; error: string };

export interface Mailer {
  /** False when no SMTP URL is configured; `send` then fails without trying. */
  readonly enabled: boolean;
  send(message: MailMessage): Promise<MailResult>;
  close(): void;
}

export type StartTls = 'required' | 'optional' | 'off';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (`smtps://`). */
  secure: boolean;
  startTls: StartTls;
  auth?: { user: string; pass: string } | undefined;
}

export interface MailerOptions {
  /** `SMTP_URL`; empty or undefined disables sending. */
  url?: string | undefined;
  /** `SMTP_FROM`, e.g. `DiRouter <noreply@example.com>`. */
  from: string;
  /** Defaults to NODE_ENV === 'production'; decides the STARTTLS default. */
  production?: boolean | undefined;
  /** Extra trust anchors (tests, private CAs). Verification itself cannot be switched off. */
  ca?: string | Buffer | undefined;
  /** Connection, greeting and socket timeout; default 10 seconds. */
  timeoutMs?: number | undefined;
}

const STARTTLS_VALUES = new Set<StartTls>(['required', 'optional', 'off']);
/** One plain address: no display name, no list. */
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** True for one plain address (no display name, no list). */
export function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value);
}

/** Parses `SMTP_URL`; throws an Error that names the problem (never echoing the password). */
export function parseSmtpUrl(raw: string, production = false): SmtpConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('SMTP_URL is not a valid URL');
  }
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:')
    throw new Error('SMTP_URL must start with smtp:// or smtps://');
  if (!url.hostname) throw new Error('SMTP_URL has no host');
  const secure = url.protocol === 'smtps:';
  const requested = url.searchParams.get('starttls');
  if (requested !== null && !STARTTLS_VALUES.has(requested as StartTls))
    throw new Error('SMTP_URL starttls must be required, optional or off');
  const startTls: StartTls = secure
    ? 'off'
    : ((requested as StartTls | null) ?? (production ? 'required' : 'optional'));
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  const user = decodeURIComponent(url.username);
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    secure,
    startTls,
    ...(user ? { auth: { user, pass: decodeURIComponent(url.password) } } : {}),
  };
}

function transportOptions(config: SmtpConfig, options: MailerOptions) {
  const timeout = options.timeoutMs ?? 10_000;
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.startTls === 'required',
    ignoreTLS: config.startTls === 'off',
    ...(config.auth ? { auth: config.auth } : {}),
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2' as const,
      ...(options.ca ? { ca: options.ca } : {}),
    },
  };
}

/** A transport error without credentials or the server's full transcript. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'mail delivery failed';
  const code = (error as { code?: unknown }).code;
  const message = error.message.replace(/\s+/g, ' ').slice(0, 300);
  return typeof code === 'string' ? `${code}: ${message}` : message;
}

export function createMailer(options: MailerOptions): Mailer {
  const url = options.url?.trim();
  if (!url)
    return {
      enabled: false,
      send: () => Promise.resolve({ ok: false, error: 'SMTP is not configured (SMTP_URL)' }),
      close: () => undefined,
    };
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const transport = nodemailer.createTransport(
    transportOptions(parseSmtpUrl(url, production), options),
  );
  return {
    enabled: true,
    async send(message) {
      const recipients = typeof message.to === 'string' ? [message.to] : [...message.to];
      if (recipients.length === 0 || !recipients.every(isEmailAddress))
        return { ok: false, error: 'invalid recipient address' };
      try {
        const info = await transport.sendMail({
          from: options.from,
          to: recipients,
          // Header values are single-line; nodemailer encodes, this keeps the subject readable.
          subject: message.subject.replace(/[\r\n]+/g, ' ').slice(0, 250),
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        });
        return { ok: true, messageId: info.messageId };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },
    close() {
      transport.close();
    },
  };
}
