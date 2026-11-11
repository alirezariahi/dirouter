/**
 * Global filter: every error is converted to application/problem+json with a stable code.
 */
import { type FieldError, DiRouterError, type Logger, ValidationError } from '@dirouter/shared';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

const HTTP_TO_CODE: Record<number, DiRouterError['code']> = {
  [HttpStatus.BAD_REQUEST]: 'invalid_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthenticated',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'request_too_large',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'validation_failed',
  [HttpStatus.TOO_MANY_REQUESTS]: 'rate_limited',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'service_unavailable',
};

function fromHttpException(error: HttpException): DiRouterError {
  const status = error.getStatus();
  const code = HTTP_TO_CODE[status] ?? (status >= 500 ? 'internal_error' : 'invalid_request');
  return new DiRouterError(code, { message: error.message, status, cause: error });
}

/** Converts Prisma unique/foreign-key errors to a stable code. */
function fromPrisma(error: { code?: unknown; meta?: unknown }): DiRouterError | undefined {
  if (error.code === 'P2002') {
    return new DiRouterError('conflict', {
      message: 'A resource with the same identifier already exists',
    });
  }
  if (error.code === 'P2025') return new DiRouterError('not_found');
  if (error.code === 'P2003') {
    return new DiRouterError('invalid_request', { message: 'Referenced resource does not exist' });
  }
  return undefined;
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    let error: DiRouterError;
    if (exception instanceof DiRouterError) error = exception;
    else if (exception instanceof HttpException) error = fromHttpException(exception);
    else if (exception && typeof exception === 'object' && 'code' in exception)
      error = fromPrisma(exception) ?? new DiRouterError('internal_error', { cause: exception });
    else error = new DiRouterError('internal_error', { cause: exception });

    if (error.status >= 500) {
      this.logger.error(
        { err: exception, requestId: request.id, url: request.url },
        'request failed',
      );
    }

    const problem = error.toProblem(request.id);
    // Internal error messages are not leaked to the client.
    if (error.code === 'internal_error') problem.detail = 'Internal error';
    if (error instanceof ValidationError) problem.errors = error.errors satisfies FieldError[];
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0)
      void reply.header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    void reply
      .status(error.status)
      .header('content-type', 'application/problem+json')
      .send(problem);
  }
}
