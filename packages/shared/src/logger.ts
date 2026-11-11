/**
 * Structured logger (pino, JSON) with automatic redaction of sensitive fields.
 */
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SENSITIVE_KEYS = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'apiKey',
  'api_key',
  'secret',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'masterKey',
];

/**
 * Redact paths. pino supports only one wildcard per path, so
 * sensitive keys are covered at the root and up to three levels deep (e.g. `req.headers.authorization`)
 * are redacted.
 */
export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => {
  const k = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) => (k.startsWith('[') ? `${prefix}${k}` : `${prefix}.${k}`);
  return [k, join('*'), join('*.*'), join('*.*.*')];
});

export const REDACTED = '[REDACTED]';

export interface CreateLoggerOptions {
  /** Service name, e.g. `gateway`; it appears in the `service` field of every log. */
  service: string;
  level?: LogLevel;
  /** Extra fixed fields for all logs. */
  base?: Record<string, unknown>;
  /** Additional redact paths. */
  redact?: string[];
  /** Output destination (default stdout); used in tests. */
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const config: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: options.service, pid: process.pid, ...options.base },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [...REDACT_PATHS, ...(options.redact ?? [])],
      censor: REDACTED,
    },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}
