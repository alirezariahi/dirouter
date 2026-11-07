/**
 * لاگر ساخت‌یافته (pino، JSON) با redact خودکار فیلدهای حساس.
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
 * مسیرهای redact. pino در هر مسیر فقط یک wildcard را پشتیبانی می‌کند، پس
 * کلیدهای حساس در ریشه و تا سه سطح عمق (مثل `req.headers.authorization`) پوشش
 * داده می‌شوند.
 */
export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => {
  const k = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
  const join = (prefix: string) => (k.startsWith('[') ? `${prefix}${k}` : `${prefix}.${k}`);
  return [k, join('*'), join('*.*'), join('*.*.*')];
});

export const REDACTED = '[REDACTED]';

export interface CreateLoggerOptions {
  /** نام سرویس، مثلاً `gateway`؛ در فیلد `service` هر لاگ می‌آید. */
  service: string;
  level?: LogLevel;
  /** فیلدهای ثابت اضافه برای همهٔ لاگ‌ها. */
  base?: Record<string, unknown>;
  /** مسیرهای redact اضافه. */
  redact?: string[];
  /** مقصد خروجی (پیش‌فرض stdout)؛ در تست استفاده می‌شود. */
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
