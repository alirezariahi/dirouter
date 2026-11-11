/**
 * Standard error formats and the taxonomy of stable error codes.
 *
 * - control-api returns errors as `application/problem+json` (RFC 9457).
 * - The gateway returns errors in the inbound API format (OpenAI or Anthropic) so that SDKs
 *   keep working unchanged; the stable DiRouter code is in the `code` field.
 */
import { z } from 'zod';

/** Error type in the official OpenAI API. */
export const OpenAIErrorType = z.enum([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'insufficient_quota',
  'server_error',
  'api_error',
]);
export type OpenAIErrorType = z.infer<typeof OpenAIErrorType>;

/** Error type in the official Anthropic API. */
export const AnthropicErrorType = z.enum([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'timeout_error',
  'api_error',
  'overloaded_error',
]);
export type AnthropicErrorType = z.infer<typeof AnthropicErrorType>;

interface ErrorCodeSpec {
  status: number;
  openai: OpenAIErrorType;
  anthropic: AnthropicErrorType;
  title: string;
}

/**
 * Stable error codes. These codes are part of the public contract: removing or changing their meaning is forbidden,
 * only additions are allowed.
 */
export const ERROR_CODES = {
  // Request
  invalid_request: {
    status: 400,
    openai: 'invalid_request_error',
    anthropic: 'invalid_request_error',
    title: 'Invalid request',
  },
  validation_failed: {
    status: 422,
    openai: 'invalid_request_error',
    anthropic: 'invalid_request_error',
    title: 'Validation failed',
  },
  request_too_large: {
    status: 413,
    openai: 'invalid_request_error',
    anthropic: 'request_too_large',
    title: 'Request too large',
  },
  context_length_exceeded: {
    status: 400,
    openai: 'invalid_request_error',
    anthropic: 'invalid_request_error',
    title: 'Context length exceeded',
  },
  // Authentication and authorization
  unauthenticated: {
    status: 401,
    openai: 'authentication_error',
    anthropic: 'authentication_error',
    title: 'Authentication required',
  },
  invalid_api_key: {
    status: 401,
    openai: 'authentication_error',
    anthropic: 'authentication_error',
    title: 'Invalid API key',
  },
  api_key_expired: {
    status: 401,
    openai: 'authentication_error',
    anthropic: 'authentication_error',
    title: 'API key expired',
  },
  invalid_credentials: {
    status: 401,
    openai: 'authentication_error',
    anthropic: 'authentication_error',
    title: 'Invalid email or password',
  },
  /** A previously used refresh token: a sign of theft; the whole session family is invalidated. */
  refresh_token_reused: {
    status: 401,
    openai: 'authentication_error',
    anthropic: 'authentication_error',
    title: 'Refresh token reuse detected',
  },
  login_locked: {
    status: 429,
    openai: 'rate_limit_error',
    anthropic: 'rate_limit_error',
    title: 'Too many failed login attempts',
  },
  setup_completed: {
    status: 409,
    openai: 'invalid_request_error',
    anthropic: 'invalid_request_error',
    title: 'Setup has already been completed',
  },
  forbidden: {
    status: 403,
    openai: 'permission_error',
    anthropic: 'permission_error',
    title: 'Forbidden',
  },
  model_not_allowed: {
    status: 403,
    openai: 'permission_error',
    anthropic: 'permission_error',
    title: 'Model not allowed for this key',
  },
  // Resources
  not_found: {
    status: 404,
    openai: 'not_found_error',
    anthropic: 'not_found_error',
    title: 'Not found',
  },
  model_not_found: {
    status: 404,
    openai: 'not_found_error',
    anthropic: 'not_found_error',
    title: 'Model not found',
  },
  conflict: {
    status: 409,
    openai: 'invalid_request_error',
    anthropic: 'invalid_request_error',
    title: 'Conflict',
  },
  // Limits and budget
  rate_limited: {
    status: 429,
    openai: 'rate_limit_error',
    anthropic: 'rate_limit_error',
    title: 'Rate limit exceeded',
  },
  budget_exceeded: {
    status: 429,
    openai: 'insufficient_quota',
    anthropic: 'billing_error',
    title: 'Budget exceeded',
  },
  // upstream
  upstream_error: {
    status: 502,
    openai: 'api_error',
    anthropic: 'api_error',
    title: 'Upstream provider error',
  },
  upstream_timeout: {
    status: 504,
    openai: 'api_error',
    anthropic: 'timeout_error',
    title: 'Upstream provider timeout',
  },
  upstream_overloaded: {
    status: 529,
    openai: 'server_error',
    anthropic: 'overloaded_error',
    title: 'Upstream provider overloaded',
  },
  no_available_provider: {
    status: 503,
    openai: 'server_error',
    anthropic: 'overloaded_error',
    title: 'No available provider',
  },
  // Internal
  service_unavailable: {
    status: 503,
    openai: 'server_error',
    anthropic: 'api_error',
    title: 'Service unavailable',
  },
  internal_error: {
    status: 500,
    openai: 'server_error',
    anthropic: 'api_error',
    title: 'Internal error',
  },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;
export const ErrorCode = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

export const PROBLEM_TYPE_BASE = 'https://dirouter.dev/errors/' as const;

/** RFC 9457 Problem Details with DiRouter's extra fields. */
export const ProblemDetails = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: ErrorCode,
  requestId: z.string().optional(),
  /** Field-by-field validation errors. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** OpenAI-compatible error body. */
export const OpenAIErrorBody = z.looseObject({
  error: z.looseObject({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string().nullable(),
  }),
});
export type OpenAIErrorBody = z.infer<typeof OpenAIErrorBody>;

/** Anthropic-compatible error body. */
export const AnthropicErrorBody = z.looseObject({
  type: z.literal('error'),
  error: z.looseObject({
    type: z.string(),
    message: z.string(),
  }),
  request_id: z.string().optional(),
});
export type AnthropicErrorBody = z.infer<typeof AnthropicErrorBody>;
