/**
 * Error classes with stable codes. The codes and the HTTP/OpenAI/Anthropic mappings are defined in
 * `@dirouter/contracts`; this file only contains the behavior and format conversion.
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
  /** Message shown to the client; defaults to the code title. */
  message?: string;
  cause?: unknown;
  /** Extra information for logs (not sent to the client). */
  meta?: Record<string, unknown>;
  /** Name of the offending parameter (the `param` field in OpenAI). */
  param?: string;
  /** HTTP status that differs from the code's default (e.g. the actual upstream status). */
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

  /** Is retrying (or falling back to another provider) reasonable? */
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

  // Only narrows the type of `code` to the authentication codes.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    code: Extract<
      ErrorCode,
      | 'unauthenticated'
      | 'invalid_api_key'
      | 'api_key_expired'
      | 'invalid_credentials'
      | 'refresh_token_reused'
    >,
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
  /** Suggested time until retry (for the `Retry-After` header). */
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
  /** HTTP status of the provider's response, if a response was received. */
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

/** Converts any unknown error to `internal_error` and keeps the original error in `cause`. */
export function toDiRouterError(error: unknown): DiRouterError {
  if (isDiRouterError(error)) return error;
  return new DiRouterError('internal_error', { cause: error });
}
