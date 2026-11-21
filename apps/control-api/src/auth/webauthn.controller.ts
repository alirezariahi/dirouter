/**
 * Passkey registration and login (card 14.1): WebAuthn options, verification and session issuance.
 * Challenges live in Valkey for five minutes and are single-use. Registration challenges are keyed
 * by user, login challenges by the challenge value itself (so usernameless logins work and a login
 * challenge can never be confused with a registration one).
 */
import { randomBytes } from 'node:crypto';

import { DiRouterError } from '@dirouter/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createPublicKey } from 'node:crypto';
import { API_PREFIX } from '../bootstrap.js';
import { ApiZodBody, ApiZodOk, JsonListSchema, JsonObjectSchema, ZodPipe } from '../common/zod.js';
import { ENV, type Env } from '../env.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { AccessGuard, assertOwnCredentialSession, CurrentUser } from './auth.guard.js';
import { AuthService, type ClientInfo } from './auth.service.js';
import { REFRESH_COOKIE } from './auth.controller.js';
import { type AccessClaims, REFRESH_TTL_SECONDS } from './crypto.js';
import { auditUserEvent } from './user-audit.js';
import {
  CborError,
  cborDecode,
  clientDataChallenge,
  counterRegressed,
  verifyAssertion,
  verifyRegistration,
} from './webauthn.js';

const CHALLENGE_TTL = 300;
const registrationKey = (userId: string) => `webauthn:reg:${userId}`;
const loginKey = (challenge: string) => `webauthn:login:${challenge}`;

const RegistrationBody = z.object({
  clientDataJSON: z.string().min(1),
  attestationObject: z.string().min(1),
  name: z.string().trim().max(60).optional(),
});
const LoginOptionsBody = z.object({ email: z.email().optional() });
const AssertionBody = z.object({
  id: z.string().min(1),
  clientDataJSON: z.string().min(1),
  authenticatorData: z.string().min(1),
  signature: z.string().min(1),
});

interface StoredKey {
  jwk: Record<string, unknown>;
  alg: 'ES256' | 'RS256';
}

const client = (req: FastifyRequest): ClientInfo => ({
  ip: req.ip,
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
});

@ApiTags('auth')
@Controller('auth/webauthn')
export class WebAuthnController {
  readonly #origin: string;
  readonly #rpId: string;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {
    const url = new URL(env.PUBLIC_DASHBOARD_URL);
    this.#origin = url.origin;
    this.#rpId = url.hostname;
  }

  @Get()
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodOk(JsonListSchema)
  async list(@CurrentUser() user: AccessClaims) {
    const rows = await this.prisma.client.webAuthnCredential.findMany({
      where: { userId: user.sub },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    }));
  }

  @Post('options')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodOk(z.object({ challenge: z.string(), rp: z.object({ id: z.string(), name: z.string() }) }))
  async registrationOptions(@CurrentUser() user: AccessClaims) {
    assertOwnCredentialSession(user);
    const challenge = randomBytes(32).toString('base64url');
    await this.valkey.client.setex(registrationKey(user.sub), CHALLENGE_TTL, challenge);
    return {
      challenge,
      rp: { id: this.#rpId, name: 'DiRouter' },
      user: { id: user.sub, name: user.email, displayName: user.email },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: CHALLENGE_TTL * 1_000,
      attestation: 'none',
    };
  }

  @Post('verify')
  @HttpCode(201)
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  @ApiZodBody(RegistrationBody)
  @ApiZodOk(JsonObjectSchema)
  async verifyRegistration(
    @CurrentUser() user: AccessClaims,
    @Body(new ZodPipe(RegistrationBody)) body: z.infer<typeof RegistrationBody>,
    @Req() req: FastifyRequest,
  ) {
    assertOwnCredentialSession(user);
    const challenge = await this.valkey.client.get(registrationKey(user.sub));
    if (!challenge) throw new DiRouterError('validation_failed', { message: 'Challenge expired' });
    const parsed = rejectInvalid('validation_failed', () =>
      verifyRegistration(body, { challenge, origin: this.#origin, rpId: this.#rpId }),
    );
    // Single use: only the request that removes the challenge may store a credential.
    if ((await this.valkey.client.del(registrationKey(user.sub))) !== 1)
      throw new DiRouterError('validation_failed', { message: 'Challenge expired' });
    const stored: StoredKey = {
      jwk: parsed.publicKey.export({ format: 'jwk' }),
      alg: parsed.alg,
    };
    const credentialId = parsed.credentialId.toString('base64url');
    const row = await this.prisma.client.webAuthnCredential.create({
      data: {
        id: `wak_${randomBytes(12).toString('hex')}`,
        userId: user.sub,
        credentialId,
        publicKey: Buffer.from(JSON.stringify(stored), 'utf8'),
        counter: BigInt(parsed.signCount),
        name: body.name ?? 'passkey',
      },
    });
    await auditUserEvent(this.prisma, {
      userId: user.sub,
      action: 'passkey.added',
      targetType: 'passkey',
      targetId: row.id,
      ip: req.ip,
      diff: { name: row.name },
    });
    return { id: row.id, name: row.name };
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AccessGuard)
  @ApiBearerAuth()
  async remove(
    @CurrentUser() user: AccessClaims,
    @Param('id') id: string,
    @Req() req: FastifyRequest,
  ) {
    assertOwnCredentialSession(user);
    const removed = await this.prisma.client.webAuthnCredential.deleteMany({
      where: { id, userId: user.sub },
    });
    if (removed.count > 0)
      await auditUserEvent(this.prisma, {
        userId: user.sub,
        action: 'passkey.removed',
        targetType: 'passkey',
        targetId: id,
        ip: req.ip,
      });
  }

  /** Login options without an email are discoverable-credential (resident key) flows. */
  @Post('login/options')
  @HttpCode(200)
  @ApiZodBody(LoginOptionsBody)
  @ApiZodOk(JsonObjectSchema)
  async loginOptions(@Body(new ZodPipe(LoginOptionsBody)) body: z.infer<typeof LoginOptionsBody>) {
    const challenge = randomBytes(32).toString('base64url');
    let allowCredentials: { type: 'public-key'; id: string }[] = [];
    if (body.email) {
      const user = await this.prisma.client.user.findUnique({
        where: { email: body.email.toLowerCase() },
        include: { webauthn: true },
      });
      if (user)
        allowCredentials = user.webauthn.map((c) => ({ type: 'public-key', id: c.credentialId }));
    }
    // Keyed by the challenge itself: the verify step finds it through clientDataJSON.challenge, with
    // or without an email. The signature proves which credential (and so which user) answered.
    await this.valkey.client.setex(loginKey(challenge), CHALLENGE_TTL, '1');
    return {
      challenge,
      rpId: this.#rpId,
      timeout: CHALLENGE_TTL * 1_000,
      userVerification: 'required',
      allowCredentials,
    };
  }

  @Post('login/verify')
  @HttpCode(200)
  @ApiZodBody(AssertionBody)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiZodOk(JsonObjectSchema)
  async loginVerify(
    @Body(new ZodPipe(AssertionBody)) body: z.infer<typeof AssertionBody>,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const credential = await this.prisma.client.webAuthnCredential.findUnique({
      where: { credentialId: body.id },
    });
    if (!credential) throw new DiRouterError('unauthenticated', { message: 'Unknown passkey' });
    const stored = JSON.parse(Buffer.from(credential.publicKey).toString('utf8')) as StoredKey;
    const challenge = clientDataChallenge(body.clientDataJSON);
    // DEL is the single-use check: it only returns 1 for a challenge this server issued and that
    // nobody has consumed yet.
    if (!challenge || (await this.valkey.client.del(loginKey(challenge))) !== 1)
      throw new DiRouterError('unauthenticated', { message: 'Challenge expired' });
    const publicKey = createPublicKey({ key: stored.jwk, format: 'jwk' } as never);
    const result = rejectInvalid('unauthenticated', () =>
      verifyAssertion(body, {
        challenge,
        origin: this.#origin,
        rpId: this.#rpId,
        publicKey,
        alg: stored.alg,
      }),
    );
    if (counterRegressed(credential.counter, result.signCount))
      throw new DiRouterError('unauthenticated', {
        message: 'Passkey signature counter went backwards; the passkey may have been cloned',
      });
    // Conditional on the counter that was checked, so two parallel assertions cannot both pass.
    const advanced = await this.prisma.client.webAuthnCredential.updateMany({
      where: { id: credential.id, counter: credential.counter },
      data: { counter: BigInt(result.signCount), lastUsedAt: new Date() },
    });
    if (advanced.count !== 1)
      throw new DiRouterError('unauthenticated', { message: 'Passkey was used concurrently' });
    const session = await this.auth.sessionFor(credential.userId, client(req), 'passkey');
    void reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.#origin.startsWith('https'),
      sameSite: 'strict',
      path: `/${API_PREFIX}/auth`,
      maxAge: REFRESH_TTL_SECONDS,
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }
}

/** Malformed or failing WebAuthn input is a client error, not a 500. */
function rejectInvalid<T>(code: 'validation_failed' | 'unauthenticated', run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof DiRouterError) throw error;
    throw new DiRouterError(code, {
      message:
        error instanceof CborError
          ? `Passkey rejected: ${error.message}`
          : 'Invalid passkey response',
      cause: error,
    });
  }
}

export const webauthnDecode = cborDecode;
