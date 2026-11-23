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
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { ensureWallet, fromUnits, postTransaction, SYSTEM_WALLETS, toUnits } from '@dirouter/db';
import { DiRouterError, prefixedId, RateLimitError } from '@dirouter/shared';
import { Inject, Injectable } from '@nestjs/common';

import { hashPassword } from '../auth/crypto.js';
import { AuthService, type ClientInfo, type Session } from '../auth/auth.service.js';
import { slugify } from '../common/ids.js';
import { ENV, type Env } from '../env.js';
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
   * Creates the user's own organization: prepaid wallet, default project, optional welcome credit.
   * Runs in one transaction with the user, so a failure leaves nothing behind.
   */
  async #provision(input: {
    email: string;
    name: string;
    passwordHash: string;
    organizationName?: string | undefined;
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
    const welcome = (await this.payments.settings()).portal.welcomeCreditUsd;
    if (toUnits(welcome) > 0n) {
      const posted = await postTransaction(this.db, {
        kind: 'gift',
        idempotencyKey: `welcome:${result.org.id}`,
        description: 'Welcome credit',
        legs: [
          { walletId: wallet.id, amountUsd: welcome },
          { walletId: SYSTEM_WALLETS.promo, amountUsd: `-${welcome}` },
        ],
      });
      await this.wallets.mirror(posted.wallets);
    } else {
      await this.wallets.mirror([{ walletId: wallet.id, balanceUsd: '0.00000000', version: 0 }]);
    }
    return result;
  }

  async signup(
    input: { email: string; name: string; password: string; organizationName?: string | undefined },
    client: ClientInfo,
  ): Promise<Session> {
    await this.#requireSignup();
    await this.#limit(client);
    const { user } = await this.#provision({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await hashPassword(input.password),
      organizationName: input.organizationName,
    });
    return this.auth.issueSession(user, client);
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
    });
    return this.auth.issueSession(user, client);
  }
}
