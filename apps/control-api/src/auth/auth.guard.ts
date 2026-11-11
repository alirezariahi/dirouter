/** Dashboard access token guard: `Authorization: Bearer <jwt>` → `request.user`. */
import { AuthenticationError } from '@dirouter/shared';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { AccessClaims } from './crypto.js';
import { AuthService } from './auth.service.js';

type AuthedRequest = FastifyRequest & { user?: AccessClaims };

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : undefined;
    const claims = token ? await this.auth.tokens.verifyAccess(token) : undefined;
    if (!claims) throw new AuthenticationError('unauthenticated');
    req.user = claims;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new AuthenticationError('unauthenticated');
  return user;
});
