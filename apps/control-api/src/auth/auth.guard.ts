/** Dashboard access token guard: `Authorization: Bearer <jwt>` → `request.user`. */
import { AuthenticationError, ForbiddenError } from '@dirouter/shared';
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
import { SessionsService } from './sessions.service.js';

type AuthedRequest = FastifyRequest & { user?: AccessClaims };

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : undefined;
    const claims = token ? await this.auth.tokens.verifyAccess(token) : undefined;
    if (!claims) throw new AuthenticationError('unauthenticated');
    // A revoked session (sign-out elsewhere, an administrator, a password change or a reused
    // refresh token) also ends its access tokens at once (card 23.5).
    if (claims.sid && !(await this.sessions.isActive(claims.sid)))
      throw new AuthenticationError('unauthenticated', { message: 'The session was signed out' });
    req.user = claims;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const user = context.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new AuthenticationError('unauthenticated');
  return user;
});

/**
 * Sign-in methods of the account (TOTP, passkeys) can only be managed from a session the user opened
 * with their own credentials. An SSO session is vouched for by one organization's identity provider;
 * letting it enroll a passkey or TOTP secret would turn that into access to the whole account.
 */
export function assertOwnCredentialSession(user: AccessClaims): void {
  if (user.amr === 'sso')
    throw new ForbiddenError('forbidden', {
      message: 'Sign in with your password or a passkey to change sign-in methods',
    });
}
