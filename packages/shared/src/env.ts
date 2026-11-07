/**
 * اعتبارسنجی متغیرهای محیطی با zod و کرش سریع هنگام بوت.
 */
import { z } from 'zod';

import { parseKeyring, type Keyring } from './crypto.js';
import { LOG_LEVELS } from './logger.js';

export interface EnvIssue {
  variable: string;
  /** پیام فارسی. */
  fa: string;
  /** پیام انگلیسی (از zod). */
  en: string;
}

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    const lines = issues.map((i) => `  - ${i.variable}: ${i.fa} / ${i.en}`);
    super(
      [
        'پیکربندی محیط نامعتبر است / Invalid environment configuration:',
        ...lines,
        'فایل .env.example را ببینید / See .env.example',
      ].join('\n'),
    );
    this.issues = issues;
  }
}

function persianMessage(issue: z.core.$ZodIssue, value: unknown): string {
  if (value === undefined || value === '') return 'مقدار الزامی وارد نشده است';
  switch (issue.code) {
    case 'invalid_type':
      return 'نوع مقدار نامعتبر است';
    case 'invalid_value':
      return 'مقدار جزو گزینه‌های مجاز نیست';
    case 'too_small':
      return 'مقدار کوچک‌تر یا کوتاه‌تر از حد مجاز است';
    case 'too_big':
      return 'مقدار بزرگ‌تر یا بلندتر از حد مجاز است';
    case 'invalid_format':
      return 'قالب مقدار نامعتبر است';
    default:
      return 'مقدار نامعتبر است';
  }
}

/**
 * env را با اسکیما parse می‌کند. در صورت خطا `EnvValidationError` با فهرست کامل
 * متغیرهای مشکل‌دار پرتاب می‌شود (نه فقط اولی).
 */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const variable = issue.path.map(String).join('.') || '(root)';
    const value = issue.path.length > 0 ? source[String(issue.path[0])] : undefined;
    return { variable, fa: persianMessage(issue, value), en: issue.message };
  });
  throw new EnvValidationError(issues);
}

/**
 * مثل `parseEnv` اما در صورت خطا پیام را روی stderr می‌نویسد و پروسه را با کد ۱
 * متوقف می‌کند. برای نقطهٔ ورود اپ‌ها.
 */
export function loadEnvOrExit<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  try {
    return parseEnv(schema, source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`\n${error.message}\n\n`);
      process.exit(1);
    }
    throw error;
  }
}

// ───────────── Helpers ─────────────

/** boolean از رشته: `true/1/yes/on` و `false/0/no/off`. */
export const envBoolean = (defaultValue?: boolean) => {
  const schema = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']))
    .transform((v) => ['true', '1', 'yes', 'on'].includes(v));
  return defaultValue === undefined ? schema : schema.default(defaultValue);
};

export const envPort = (defaultValue?: number) => {
  const schema = z.coerce.number().int().min(1).max(65_535);
  return defaultValue === undefined ? schema : schema.default(defaultValue);
};

/** keyring رمزنگاری از env (قالب `parseKeyring`)؛ کلید نامعتبر هنگام بوت رد می‌شود. */
export const envKeyring = () =>
  z.string().transform((value, ctx): Keyring => {
    try {
      return parseKeyring(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });

/** متغیرهای مشترک همهٔ سرویس‌ها. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});
export type BaseEnv = z.infer<typeof baseEnvSchema>;
