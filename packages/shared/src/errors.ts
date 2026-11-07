/**
 * کلاس‌های خطا با کد پایدار. کدها و نگاشت HTTP/OpenAI/Anthropic در
 * `@dirouter/contracts` تعریف شده‌اند؛ این‌جا فقط رفتار و تبدیل قالب است.
 */
import {
  ERROR_CODES,
  PROBLEM_TYPE_BASE,
  type AnthropicErrorBody,
  type ErrorCode,
  type OpenAIErrorBody,
  type ProblemDetails,
} from '@dirouter/contracts';

export interface FieldError {
  path: string;
  message: string;
}

export interface DiRouterErrorOptions {
  /** متن قابل‌نمایش برای کلاینت؛ پیش‌فرض عنوان کد. */
  message?: string;
  cause?: unknown;
  /** اطلاعات اضافه برای لاگ (به کلاینت فرستاده نمی‌شود). */
  meta?: Record<string, unknown>;
  /** نام پارامتر مشکل‌دار (فیلد `param` در OpenAI). */
  param?: string;
  /** وضعیت HTTP متفاوت از پیش‌فرض کد (مثلاً status واقعی upstream). */
  status?: number;
}

export class DiRouterError extends Error {
  override readonly name: string = 'DiRouterError';
  readonly code: ErrorCode;
  readonly status: number;
  readonly meta: Record<string, unknown>;
  readonly param: string | undefined;

  constructor(code: ErrorCode, options: DiRouterErrorOptions = {}) {
    super(options.message ?? ERROR_CODES[code].title, { cause: options.cause });
    this.code = code;
    this.status = options.status ?? ERROR_CODES[code].status;
    this.meta = options.meta ?? {};
    this.param = options.param;
  }

  /** آیا تلاش دوباره (یا فال‌بک به provider دیگر) منطقی است؟ */
  get retryable(): boolean {
    return false;
  }

  toProblem(requestId?: string): ProblemDetails {
    return {
      type: `${PROBLEM_TYPE_BASE}${this.code}`,
      title: ERROR_CODES[this.code].title,
      status: this.status,
      detail: this.message,
      code: this.code,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  toOpenAI(): OpenAIErrorBody {
    return {
      error: {
        message: this.message,
        type: ERROR_CODES[this.code].openai,
        param: this.param ?? null,
        code: this.code,
      },
    };
  }

  toAnthropic(requestId?: string): AnthropicErrorBody {
    return {
      type: 'error',
      error: { type: ERROR_CODES[this.code].anthropic, message: this.message },
      ...(requestId === undefined ? {} : { request_id: requestId }),
    };
  }
}

export class ValidationError extends DiRouterError {
  override readonly name = 'ValidationError';
  readonly errors: FieldError[];

  constructor(errors: FieldError[], options: DiRouterErrorOptions = {}) {
    super('validation_failed', {
      message: errors.map((e) => `${e.path}: ${e.message}`).join('; ') || undefined,
      ...options,
    });
    this.errors = errors;
  }

  override toProblem(requestId?: string): ProblemDetails {
    return { ...super.toProblem(requestId), errors: this.errors };
  }
}

export class AuthenticationError extends DiRouterError {
  override readonly name = 'AuthenticationError';

  // فقط نوع `code` را به کدهای احراز هویت محدود می‌کند.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    code: Extract<ErrorCode, 'unauthenticated' | 'invalid_api_key' | 'api_key_expired'>,
    options?: DiRouterErrorOptions,
  ) {
    super(code, options);
  }
}

export class ForbiddenError extends DiRouterError {
  override readonly name = 'ForbiddenError';

  constructor(
    code: Extract<ErrorCode, 'forbidden' | 'model_not_allowed'> = 'forbidden',
    options?: DiRouterErrorOptions,
  ) {
    super(code, options);
  }
}

export class NotFoundError extends DiRouterError {
  override readonly name = 'NotFoundError';

  constructor(
    code: Extract<ErrorCode, 'not_found' | 'model_not_found'> = 'not_found',
    options?: DiRouterErrorOptions,
  ) {
    super(code, options);
  }
}

export class RateLimitError extends DiRouterError {
  override readonly name = 'RateLimitError';
  /** زمان پیشنهادی تا تلاش دوباره (برای هدر `Retry-After`). */
  readonly retryAfterMs: number | undefined;

  constructor(options: DiRouterErrorOptions & { retryAfterMs?: number } = {}) {
    super('rate_limited', options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class BudgetExceededError extends DiRouterError {
  override readonly name = 'BudgetExceededError';

  constructor(options?: DiRouterErrorOptions) {
    super('budget_exceeded', options);
  }
}

export interface UpstreamErrorOptions extends DiRouterErrorOptions {
  providerId?: string;
  /** وضعیت HTTP پاسخ provider، اگر پاسخی آمده باشد. */
  upstreamStatus?: number;
  retryable?: boolean;
}

export class UpstreamError extends DiRouterError {
  override readonly name = 'UpstreamError';
  readonly providerId: string | undefined;
  readonly upstreamStatus: number | undefined;
  readonly #retryable: boolean;

  constructor(
    code: Extract<
      ErrorCode,
      'upstream_error' | 'upstream_timeout' | 'upstream_overloaded' | 'no_available_provider'
    > = 'upstream_error',
    options: UpstreamErrorOptions = {},
  ) {
    super(code, options);
    this.providerId = options.providerId;
    this.upstreamStatus = options.upstreamStatus;
    this.#retryable = options.retryable ?? code !== 'no_available_provider';
  }

  override get retryable(): boolean {
    return this.#retryable;
  }
}

export function isDiRouterError(error: unknown): error is DiRouterError {
  return error instanceof DiRouterError;
}

/** هر خطای ناشناخته را به `internal_error` تبدیل می‌کند و خطای اصلی را در `cause` نگه می‌دارد. */
export function toDiRouterError(error: unknown): DiRouterError {
  if (isDiRouterError(error)) return error;
  return new DiRouterError('internal_error', { cause: error });
}
