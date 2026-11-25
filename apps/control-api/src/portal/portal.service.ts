/**
 * Self-service portal backend (card 19.5).
 *
 * - The public model market: the platform's public models at their sale price, and the plans.
 * - Sign-up with email and password, or with the portal's OIDC provider (e.g. Google). Either way
 *   the user gets their own prepaid organization with a wallet, a default project and optionally a
 *   welcome credit, and can then top up, create a key and send requests without an operator.
 *
 * Sign-up is off until the operator turns it on (`billing settings → portal.signupEnabled`) and is
 * rate limited per client address.
 *
 * Email verification (card 23.4): a password sign-up starts unverified and receives a one-time link
 * (24 hours) by email. Until it is opened the account cannot create API keys and gets no welcome
 * credit; the link can be sent again, rate limited per user. An OIDC sign-in whose provider vouches
 * for the address (`email_verified: true`) counts as verified and needs no link.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ensureWallet, fromUnits, postTransaction, SYSTEM_WALLETS, toUnits } from '@dirouter/db';
import { DiRouterError, prefixedId, RateLimitError } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { hashPassword } from '../auth/crypto.js';
import { AuthService, type ClientInfo, type Session } from '../auth/auth.service.js';
import { slugify } from '../common/ids.js';
import { ENV, type Env } from '../env.js';
import { MailService } from '../infra/mail.service.js';
import { PrismaService } from '../infra/prisma.service.js';
import { ValkeyService } from '../infra/valkey.service.js';
import { PaymentsService } from '../billing/payments/payments.service.js';
import { WalletsService } from '../billing/wallets.service.js';
import {
  buildAuthorizationUrl,
  exchangeCode,
  pkceChallenge,
  SsoService,
  STATE_TTL_SECONDS,
} from '../security/sso.service.js';

/** Sign-ups allowed per client address per hour. */
export const SIGNUPS_PER_HOUR = 5;
/** Lifetime of an email verification link. */
export const VERIFY_TTL_MS = 24 * 3600 * 1000;
/** Verification emails a user can ask for per hour, and the pause between two of them. */
export const VERIFY_RESENDS_PER_HOUR = 3;
export const VERIFY_RESEND_GAP_SECONDS = 60;
const OIDC_STATE_PREFIX = 'portal:oidc:';
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/** Price of `perMTok` USD per million tokens scaled by a multiplier, as a decimal string. */
function scaled(perMTok: string, multiplier: string): string {
  return fromUnits((toUnits(perMTok) * toUnits(multiplier) + 50_000_000n) / 100_000_000n);
}

@Injectable()
export class PortalService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(WalletsService) private readonly wallets: WalletsService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  get db() {
    return this.prisma.client;
  }

  get #oidc() {
    const { PORTAL_OIDC_ISSUER: issuer, PORTAL_OIDC_CLIENT_ID: clientId } = this.env;
    const secret = this.env.PORTAL_OIDC_CLIENT_SECRET;
    return issuer && clientId && secret ? { issuer, clientId, secret } : undefined;
  }

  async config() {
    const settings = await this.payments.settings();
    return {
      signupEnabled: settings.portal.signupEnabled,
      // A password sign-up must be verified by email, so it needs a working SMTP setup.
      passwordSignup: this.mail.enabled,
      oidc: this.#oidc ? { enabled: true, name: this.env.PORTAL_OIDC_NAME } : { enabled: false },
      welcomeCreditUsd: settings.portal.welcomeCreditUsd,
    };
  }

  /** The public offer: platform models marked public, at list price, and the active plans. */
  async market() {
    const platform = await this.db.organization.findFirst({
      where: { isPlatform: true, deletedAt: null },
      select: { id: true },
    });
    if (!platform) return { models: [], plans: [] };
    const [models, plans] = await Promise.all([
      this.db.model.findMany({
        where: { organizationId: platform.id, isPublic: true, enabled: true, deletedAt: null },
        orderBy: { slug: 'asc' },
      }),
      this.db.plan.findMany({ where: { active: true }, orderBy: { priceUsd: 'asc' } }),
    ]);
    return {
      models: models.map((m) => {
        const multiplier = m.saleMultiplier.toFixed(8);
        const caps = m.capabilities as Record<string, boolean>;
        return {
          slug: m.slug,
          name: m.displayName ?? m.slug,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
          capabilities: Object.keys(caps).filter((k) => caps[k]),
          price: m.salePerRequestUsd
            ? { perRequestUsd: m.salePerRequestUsd.toFixed(8) }
            : {
                inputPerMTok: scaled(m.inputPrice.toFixed(8), multiplier),
                outputPerMTok: scaled(m.outputPrice.toFixed(8), multiplier),
                ...(m.cacheReadPrice
                  ? { cacheReadPerMTok: scaled(m.cacheReadPrice.toFixed(8), multiplier) }
                  : {}),
              },
        };
      }),
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        priceUsd: p.priceUsd.toFixed(8),
        includedUsd: p.includedUsd.toFixed(8),
      })),
    };
  }

  async #limit(client: ClientInfo) {
    const key = `portal:signups:${client.ip}`;
    const count = await this.valkey.client.incr(key).catch(() => 0);
    if (count === 1) await this.valkey.client.expire(key, 3_600).catch(() => undefined);
    if (count > SIGNUPS_PER_HOUR)
      throw new RateLimitError({
        message: 'Too many sign-ups from this address; try again later',
        retryAfterMs: 3_600_000,
      });
  }

  async #requireSignup() {
    if (!(await this.payments.settings()).portal.signupEnabled)
      throw new DiRouterError('forbidden', { message: 'Sign-up is closed' });
  }

  /**
   * Creates the user's own organization: prepaid wallet and default project, in one transaction
   * with the user so a failure leaves nothing behind. The welcome credit is only granted to a
   * verified address: here for OIDC, after the link for a password sign-up.
   */
  async #provision(input: {
    email: string;
    name: string;
    passwordHash: string;
    organizationName?: string | undefined;
    verified: boolean;
  }) {
    const slugBase = slugify(input.organizationName ?? input.name).slice(0, 40);
    const result = await this.db.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email: input.email }, select: { id: true } }))
        throw new DiRouterError('conflict', {
          message: 'An account with this email already exists; sign in instead',
        });
      const user = await tx.user.create({
        data: {
          id: prefixedId('usr'),
          email: input.email,
          name: input.name,
          passwordHash: input.passwordHash,
          emailVerifiedAt: input.verified ? new Date() : null,
        },
      });
      const org = await tx.organization.create({
        data: {
          id: prefixedId('org'),
          name: input.organizationName ?? `${input.name}'s workspace`,
          slug: `${slugBase}-${randomBytes(3).toString('hex')}`,
          prepaid: true,
          memberships: { create: { id: prefixedId('mem'), userId: user.id, role: 'OWNER' } },
          projects: { create: { id: prefixedId('prj'), name: 'Default', slug: 'default' } },
        },
      });
      await tx.auditLog.create({
        data: {
          id: prefixedId('aud'),
          organizationId: org.id,
          actorUserId: user.id,
          action: 'portal.signed_up',
          targetType: 'organization',
          targetId: org.id,
        },
      });
      return { user, org };
    });
    const wallet = await ensureWallet(this.db, result.org.id);
    await this.wallets.mirror([{ walletId: wallet.id, balanceUsd: '0.00000000', version: 0 }]);
    if (input.verified) await this.#grantWelcome(result.org.id);
    return result;
  }

  /**
   * The welcome credit of a portal workspace. The idempotency key makes it once per organization,
   * however many times verification or an OIDC sign-in reaches this point.
   */
  async #grantWelcome(organizationId: string) {
    const welcome = (await this.payments.settings()).portal.welcomeCreditUsd;
    if (toUnits(welcome) <= 0n) return;
    const wallet = await ensureWallet(this.db, organizationId);
    const posted = await postTransaction(this.db, {
      kind: 'gift',
      idempotencyKey: `welcome:${organizationId}`,
      description: 'Welcome credit',
      legs: [
        { walletId: wallet.id, amountUsd: welcome },
        { walletId: SYSTEM_WALLETS.promo, amountUsd: `-${welcome}` },
      ],
    });
    await this.wallets.mirror(posted.wallets);
  }

  /** The prepaid workspace the portal created for this user (they own it). */
  async #portalOrganization(userId: string) {
    const membership = await this.db.membership.findFirst({
      where: {
        userId,
        role: 'OWNER',
        organization: { prepaid: true, isPlatform: false, deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { organizationId: true },
    });
    return membership?.organizationId;
  }

  /** Marks the address verified and grants the welcome credit the account was waiting for. */
  async #markVerified(userId: string) {
    const changed = await this.db.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    const organizationId = await this.#portalOrganization(userId);
    if (organizationId) {
      if (changed.count === 1)
        await this.db.auditLog.create({
          data: {
            id: prefixedId('aud'),
            organizationId,
            actorUserId: userId,
            action: 'portal.email_verified',
            targetType: 'user',
            targetId: userId,
          },
        });
      await this.#grantWelcome(organizationId);
    }
  }

  /**
   * Issues a new one-time link (older unused links stop working) and emails it. Only the token's
   * hash is stored; the token itself exists in the email alone.
   */
  async #sendVerification(user: { id: string; email: string; name: string }): Promise<boolean> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.db.$transaction([
      this.db.emailVerification.updateMany({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: now } },
        data: { expiresAt: now },
      }),
      this.db.emailVerification.create({
        data: {
          id: prefixedId('evf'),
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(now.getTime() + VERIFY_TTL_MS),
        },
      }),
    ]);
    const link = `${this.env.PUBLIC_PORTAL_URL.replace(/\/+$/, '')}/verify-email?token=${token}`;
    const sent = await this.mail.send({
      to: user.email,
      subject: 'Confirm your email address for DiRouter',
      text: [
        `Hello ${user.name},`,
        '',
        'Open this link to confirm your email address and activate your account:',
        link,
        '',
        'The link works once and expires in 24 hours. Until then you cannot create API keys,',
        'and the welcome credit is added once the address is confirmed.',
        '',
        'If you did not sign up for DiRouter, you can ignore this email.',
      ].join('\n'),
    });
    return sent.ok;
  }

  async signup(
    input: { email: string; name: string; password: string; organizationName?: string | undefined },
    client: ClientInfo,
  ): Promise<Session & { emailVerified: boolean; verificationEmailSent: boolean }> {
    await this.#requireSignup();
    // Without SMTP the verification link could never arrive and the account would be stuck.
    if (!this.mail.enabled)
      throw new DiRouterError('forbidden', {
        message: 'Email sign-up is unavailable because the server cannot send email',
      });
    await this.#limit(client);
    const { user } = await this.#provision({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await hashPassword(input.password),
      organizationName: input.organizationName,
      verified: false,
    });
    const verificationEmailSent = await this.#sendVerification(user);
    return {
      ...(await this.auth.issueSession(user, client)),
      emailVerified: false,
      verificationEmailSent,
    };
  }

  /**
   * Opens a verification link. Unknown, used and expired links are refused with a reason; the
   * link is claimed with a conditional update, so two clicks at once verify only once.
   */
  async verifyEmail(token: string): Promise<{ verified: true; email: string }> {
    const row = await this.db.emailVerification.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { id: true, email: true, isActive: true, deletedAt: true } } },
    });
    const refuse = (reason: string) =>
      new DiRouterError('verification_link_invalid', { message: reason });
    if (!row || !row.user.isActive || row.user.deletedAt)
      throw refuse('This verification link is not valid');
    if (row.usedAt) throw refuse('This verification link has already been used');
    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime())
      throw refuse('This verification link has expired; ask for a new one');
    const claimed = await this.db.emailVerification.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw refuse('This verification link has already been used');
    await this.#markVerified(row.userId);
    return { verified: true, email: row.user.email };
  }

  /** Sends a fresh link to a signed-in, unverified user; rate limited per user. */
  async resendVerification(userId: string): Promise<{ sent: boolean }> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });
    if (!user) throw new DiRouterError('not_found');
    if (user.emailVerifiedAt)
      throw new DiRouterError('conflict', { message: 'This email address is already verified' });
    if (!this.mail.enabled)
      throw new DiRouterError('forbidden', {
        message: 'The server cannot send email; contact the operator',
      });
    const valkey = this.valkey.client;
    const gap = await valkey
      .set(`portal:verify-gap:${userId}`, '1', 'EX', VERIFY_RESEND_GAP_SECONDS, 'NX')
      .catch(() => 'OK');
    if (gap !== 'OK')
      throw new RateLimitError({
        message: 'A verification email was sent a moment ago; wait a minute',
        retryAfterMs: VERIFY_RESEND_GAP_SECONDS * 1000,
      });
    const key = `portal:verify-resends:${userId}`;
    const count = await valkey.incr(key).catch(() => 0);
    if (count === 1) await valkey.expire(key, 3_600).catch(() => undefined);
    if (count > VERIFY_RESENDS_PER_HOUR)
      throw new RateLimitError({
        message: 'Too many verification emails; try again later',
        retryAfterMs: 3_600_000,
      });
    return { sent: await this.#sendVerification(user) };
  }

  // ───────────── OIDC sign-in ─────────────

  #redirectUri() {
    return `${this.env.PUBLIC_PORTAL_URL.replace(/\/+$/, '')}/oauth/callback`;
  }

  /** `binding` goes into an HttpOnly cookie; the callback needs it (login CSRF protection). */
  async oidcStart() {
    const oidc = this.#oidc;
    if (!oidc) throw new DiRouterError('not_found');
    const discovery = await this.sso.discover(oidc.issuer);
    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    await this.valkey.client.set(
      `${OIDC_STATE_PREFIX}${state}`,
      JSON.stringify({ verifier, nonce, bindingHash: sha256(binding) }),
      'EX',
      STATE_TTL_SECONDS,
      'NX',
    );
    return {
      binding,
      authorizationUrl: buildAuthorizationUrl(discovery, {
        clientId: oidc.clientId,
        redirectUri: this.#redirectUri(),
        state,
        nonce,
        challenge: pkceChallenge(verifier),
      }),
    };
  }

  /** Signs in (or signs up) the user the provider vouches for, with a verified email only. */
  async oidcCallback(
    code: string,
    state: string,
    binding: string | undefined,
    client: ClientInfo,
  ): Promise<Session> {
    const oidc = this.#oidc;
    if (!oidc) throw new DiRouterError('not_found');
    const key = `${OIDC_STATE_PREFIX}${state}`;
    const raw = await this.valkey.client.get(key);
    const claimed = await this.valkey.client.del(key);
    if (!raw || claimed !== 1)
      throw new DiRouterError('invalid_request', { message: 'invalid sign-in state' });
    const record = JSON.parse(raw) as { verifier: string; nonce: string; bindingHash: string };
    const presented = Buffer.from(sha256(binding ?? ''));
    const expected = Buffer.from(record.bindingHash);
    if (!binding || presented.length !== expected.length || !timingSafeEqual(presented, expected))
      throw new DiRouterError('invalid_request', {
        message: 'Sign-in was not started in this browser',
      });
    const payload = await exchangeCode(await this.sso.discover(oidc.issuer), {
      code,
      redirectUri: this.#redirectUri(),
      clientId: oidc.clientId,
      clientSecret: oidc.secret,
      verifier: record.verifier,
      nonce: record.nonce,
    });
    if (typeof payload.email !== 'string' || payload.email_verified !== true)
      throw new DiRouterError('unauthenticated', {
        message: 'The provider did not return a verified email address',
      });
    const email = payload.email.toLowerCase();
    const existing = await this.db.user.findUnique({ where: { email } });
    if (existing) {
      if (!existing.isActive || existing.deletedAt)
        throw new DiRouterError('unauthenticated', { message: 'This account is disabled' });
      // A verified email from the portal's own provider identifies the person; but an operator
      // account must never be reachable through the public portal.
      const operator = await this.db.membership.findFirst({
        where: { userId: existing.id, organization: { isPlatform: true } },
        select: { id: true },
      });
      if (operator)
        throw new DiRouterError('forbidden', {
          message: 'Operator accounts sign in through the dashboard',
        });
      await this.db.user.update({ where: { id: existing.id }, data: { lastLoginAt: new Date() } });
      // The provider vouches for the address: a password sign-up that never opened its link is
      // verified now, without another email (card 23.4).
      if (!existing.emailVerifiedAt) await this.#markVerified(existing.id);
      return this.auth.issueSession(existing, client);
    }
    await this.#requireSignup();
    await this.#limit(client);
    const name =
      typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 100)
        : (email.split('@')[0] ?? email);
    // No password: a random hash keeps the column non-null and unusable.
    const { user } = await this.#provision({
      email,
      name,
      passwordHash: await hashPassword(randomBytes(32).toString('hex')),
      verified: true,
    });
    return this.auth.issueSession(user, client);
  }
}
