/**
 * Online wallet top-ups (card 19.2).
 *
 * A payment row is created PENDING with the amount frozen in the provider's currency. Whatever
 * reports the outcome (Zarinpal's browser callback, Stripe's signed webhook, or the reconcile job),
 * the provider itself is asked or proven to have taken the money before anything is credited, and
 * the credit is posted in the same database transaction that marks the payment SUCCEEDED. The row
 * lock on that update plus the ledger's idempotency key (`payment:<id>`) make a repeated callback,
 * a webhook retry or a race between them credit exactly once. A failed payment only changes its own
 * status.
 */
import { fromUnits, postInTransaction, SYSTEM_WALLETS, toUnits } from '@dirouter/db';
import { DiRouterError, type Logger, prefixedId } from '@dirouter/shared';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { ENV, type Env } from '../../env.js';
import { LOGGER } from '../../infra/tokens.js';
import { PrismaService } from '../../infra/prisma.service.js';
import { ValkeyService } from '../../infra/valkey.service.js';
import type { OrgContext } from '../../rbac/org.guard.js';
import { BillingSettings, type BillingSettingsInput } from '../settings.js';
import { ledgerProblem, WalletsService } from '../wallets.service.js';
import {
  type PaymentProvider,
  type PaymentProviderName,
  PaymentProviderError,
  type PaymentState,
  StripeProvider,
  ZarinpalProvider,
} from './providers.js';

/** A Zarinpal authority lives about 15 minutes; after that an unverified payment is dead. */
const ZARINPAL_ABANDONED_MS = 30 * 60_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
const RECONCILE_LOCK = 'dirouter:billing:payments:reconcile';

type PaymentRow = NonNullable<
  Awaited<ReturnType<PrismaService['client']['payment']['findUnique']>>
>;

export function paymentView(p: PaymentRow) {
  return {
    id: p.id,
    organizationId: p.organizationId,
    provider: p.provider,
    status: p.status.toLowerCase(),
    amountUsd: p.amountUsd.toFixed(8),
    currency: p.currency,
    amountMinor: p.amountMinor.toString(),
    exchangeRate: p.exchangeRate.toFixed(8),
    providerTxId: p.providerTxId,
    failureReason: p.failureReason,
    transactionId: p.transactionId,
    createdAt: p.createdAt.toISOString(),
    completedAt: p.completedAt?.toISOString() ?? null,
  };
}

/** amountUsd × rate in integer minor units, rounded up (the payer never pays less than the credit). */
export function minorUnits(amountUsd: string, rate: string, minorPerMajor: number): bigint {
  const product = toUnits(amountUsd) * toUnits(rate) * BigInt(minorPerMajor);
  const scale = 10n ** 16n;
  return (product + scale - 1n) / scale;
}

@Injectable()
export class PaymentsService implements OnModuleInit, OnApplicationShutdown {
  readonly #providers = new Map<PaymentProviderName, PaymentProvider>();
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValkeyService) private readonly valkey: ValkeyService,
    @Inject(WalletsService) private readonly wallets: WalletsService,
  ) {
    if (env.ZARINPAL_MERCHANT_ID)
      this.#providers.set(
        'zarinpal',
        new ZarinpalProvider({
          merchantId: env.ZARINPAL_MERCHANT_ID,
          baseUrl: env.ZARINPAL_BASE_URL,
        }),
      );
    if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
      this.#providers.set(
        'stripe',
        new StripeProvider({
          secretKey: env.STRIPE_SECRET_KEY,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET,
          baseUrl: env.STRIPE_BASE_URL,
        }),
      );
  }

  get db() {
    return this.prisma.client;
  }

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') return;
    this.#timer = setInterval(() => {
      void this.reconcileOnce().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'payment reconcile failed');
      });
    }, RECONCILE_EVERY_MS);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.#timer);
  }

  // ───────────── Settings ─────────────

  async settings(): Promise<BillingSettings> {
    const row = await this.db.billingSetting.findUnique({ where: { id: 'global' } });
    const parsed = BillingSettings.safeParse(row?.settings ?? {});
    return parsed.success ? parsed.data : BillingSettings.parse({});
  }

  async putSettings(ctx: OrgContext, input: BillingSettingsInput) {
    const settings = BillingSettings.parse(input);
    await this.db.billingSetting.upsert({
      where: { id: 'global' },
      create: { id: 'global', settings, updatedBy: ctx.userId },
      update: { settings, updatedBy: ctx.userId, updatedAt: new Date() },
    });
    await this.db.auditLog.create({
      data: {
        id: prefixedId('aud'),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        ...(ctx.ip ? { ip: ctx.ip } : {}),
        action: 'billing.settings_changed',
        targetType: 'billing_settings',
        targetId: 'global',
        diff: settings,
      },
    });
    return this.publicSettings(settings);
  }

  /** What a customer may use: providers that are both offered and configured, and the limits. */
  async publicSettings(settings?: BillingSettings) {
    const s = settings ?? (await this.settings());
    return {
      ...s,
      available: s.providers.filter(
        (p) => this.#providers.has(p) && (p === 'stripe' || s.exchangeRates.IRR !== undefined),
      ),
    };
  }

  // ───────────── Customer ─────────────

  #returnUrl(requested: string | undefined, paymentId: string): string {
    const allowed = new Set(
      [this.env.PUBLIC_DASHBOARD_URL, ...(this.env.PAYMENT_RETURN_ORIGINS ?? '').split(',')]
        .map((u) => u.trim())
        .filter(Boolean)
        .map((u) => new URL(u).origin),
    );
    const fallback = `${this.env.PUBLIC_DASHBOARD_URL}/billing`;
    let target: URL;
    try {
      target = new URL(requested ?? fallback);
    } catch {
      throw new DiRouterError('validation_failed', { message: 'returnUrl is not a URL' });
    }
    // An open redirect would let anyone bounce payers to a phishing page.
    if (!allowed.has(target.origin))
      throw new DiRouterError('validation_failed', { message: 'returnUrl origin is not allowed' });
    target.searchParams.set('payment', paymentId);
    return target.toString();
  }

  async create(
    ctx: OrgContext,
    input: { provider: PaymentProviderName; amountUsd: string; returnUrl?: string | undefined },
  ) {
    const settings = await this.publicSettings();
    const provider = this.#providers.get(input.provider);
    if (!provider || !settings.available.includes(input.provider))
      throw new DiRouterError('validation_failed', {
        message: `payment provider '${input.provider}' is not available`,
      });
    const amount = toUnits(input.amountUsd);
    if (amount < toUnits(settings.topup.minUsd) || amount > toUnits(settings.topup.maxUsd))
      throw new DiRouterError('validation_failed', {
        message: `amount must be between USD ${settings.topup.minUsd} and ${settings.topup.maxUsd}`,
      });
    const org = await this.db.organization.findFirst({
      where: { id: ctx.organizationId, deletedAt: null, isPlatform: false },
      select: { id: true, name: true },
    });
    if (!org)
      throw new DiRouterError('validation_failed', {
        message: 'the platform organization has no wallet to top up',
      });
    await this.wallets.ensure(org.id);
    const user = await this.db.user.findUnique({
      where: { id: ctx.userId },
      select: { email: true },
    });

    const rate =
      provider.currency === 'USD' ? '1' : (settings.exchangeRates[provider.currency] ?? '');
    const amountMinor = minorUnits(fromUnits(amount), rate, provider.minorPerMajor);
    const id = prefixedId('pay');
    const returnUrl = this.#returnUrl(input.returnUrl, id);
    await this.db.payment.create({
      data: {
        id,
        organizationId: org.id,
        provider: provider.name,
        amountUsd: fromUnits(amount),
        currency: provider.currency,
        amountMinor,
        exchangeRate: rate,
        returnUrl,
        createdById: ctx.userId,
      },
    });
    const base = `${this.env.PUBLIC_API_URL}/api/v1/payments/${provider.name}`;
    try {
      const checkout = await provider.createCheckout({
        paymentId: id,
        amountMinor,
        description: `DiRouter credit USD ${fromUnits(amount)} (${org.name})`,
        callbackUrl:
          provider.name === 'stripe' ? `${base}/return?payment=${id}` : `${base}/callback`,
        cancelUrl: `${base}/return?payment=${id}`,
        email: user?.email,
      });
      await this.db.payment.update({
        where: { id },
        data: { providerRef: checkout.providerRef },
      });
      return { paymentId: id, redirectUrl: checkout.redirectUrl };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.db.payment.update({
        where: { id },
        data: { status: 'FAILED', failureReason: reason, completedAt: new Date() },
      });
      this.logger.warn({ paymentId: id, err: error }, 'payment checkout could not be started');
      throw new DiRouterError('service_unavailable', {
        message: 'The payment provider could not start the checkout; try again later',
      });
    }
  }

  async list(organizationId: string, limit = 50) {
    const rows = await this.db.payment.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(paymentView);
  }

  async get(organizationId: string, id: string) {
    const row = await this.db.payment.findFirst({ where: { id, organizationId } });
    if (!row) throw new DiRouterError('not_found');
    return paymentView(row);
  }

  async listAll(status: string | undefined, limit: number) {
    const rows = await this.db.payment.findMany({
      where: status ? { status: status.toUpperCase() as PaymentRow['status'] } : {},
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(paymentView);
  }

  // ───────────── Provider callbacks ─────────────

  #withStatus(returnUrl: string | null, status: string): string {
    const url = new URL(returnUrl ?? `${this.env.PUBLIC_DASHBOARD_URL}/billing`);
    url.searchParams.set('status', status);
    return url.toString();
  }

  /** Zarinpal sends the payer back with `Authority` and `Status`; returns where to send them next. */
  async zarinpalCallback(authority: string, status: string): Promise<string> {
    const payment = await this.db.payment.findUnique({
      where: { provider_providerRef: { provider: 'zarinpal', providerRef: authority } },
    });
    if (!payment) return `${this.env.PUBLIC_DASHBOARD_URL}/billing?payment=unknown`;
    const state: PaymentState =
      status === 'OK'
        ? await this.#confirm(payment)
        : { state: 'failed', reason: 'cancelled by the payer' };
    const final = await this.settle(payment.id, state);
    return this.#withStatus(payment.returnUrl, final);
  }

  /** Stripe's success and cancel pages; the webhook (or reconcile) does the crediting. */
  async stripeReturn(paymentId: string): Promise<string> {
    const payment = await this.db.payment.findUnique({ where: { id: paymentId } });
    if (payment?.provider !== 'stripe')
      return `${this.env.PUBLIC_DASHBOARD_URL}/billing?payment=unknown`;
    // Look it up now so the payer usually lands on a final status rather than "pending".
    const final =
      payment.status === 'PENDING'
        ? await this.settle(payment.id, await this.#confirm(payment))
        : payment.status.toLowerCase();
    return this.#withStatus(payment.returnUrl, final);
  }

  async stripeWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const stripe = this.#providers.get('stripe') as StripeProvider | undefined;
    if (!stripe || !rawBody) throw new DiRouterError('not_found');
    let event;
    try {
      event = stripe.parseWebhook(rawBody, signature, Math.floor(Date.now() / 1000));
    } catch (error) {
      throw new DiRouterError('invalid_request', {
        message: error instanceof Error ? error.message : 'invalid webhook',
      });
    }
    const session = event.data.object;
    if (!session.id || !event.type.startsWith('checkout.session.')) return { received: true };
    const payment = await this.db.payment.findUnique({
      where: { provider_providerRef: { provider: 'stripe', providerRef: session.id } },
    });
    if (!payment) return { received: true };
    // The signed event is proof enough, but the session is read back anyway: Stripe may deliver
    // events out of order, and the current session state is the single source of truth.
    const status = await this.settle(payment.id, await this.#confirm(payment));
    return { received: true, status };
  }

  async #confirm(payment: PaymentRow): Promise<PaymentState> {
    const provider = this.#providers.get(payment.provider as PaymentProviderName);
    if (!provider || !payment.providerRef) return { state: 'pending' };
    try {
      return await provider.confirm({
        providerRef: payment.providerRef,
        amountMinor: payment.amountMinor,
      });
    } catch (error) {
      // Provider unreachable: leave it pending for the reconcile job.
      if (error instanceof PaymentProviderError) {
        this.logger.warn({ paymentId: payment.id, err: error }, 'payment confirmation failed');
        return { state: 'pending' };
      }
      throw error;
    }
  }

  /**
   * Applies the provider's answer. Credits at most once: the status update and the ledger posting
   * share one transaction, and the update only matches a payment that is not yet succeeded.
   * Returns the payment's status afterwards.
   */
  async settle(paymentId: string, state: PaymentState): Promise<string> {
    if (state.state === 'pending') {
      const row = await this.db.payment.findUnique({ where: { id: paymentId } });
      return row?.status.toLowerCase() ?? 'unknown';
    }
    if (state.state !== 'paid') {
      await this.db.payment.updateMany({
        where: { id: paymentId, status: 'PENDING' },
        data: {
          status: state.state === 'expired' ? 'EXPIRED' : 'FAILED',
          failureReason: state.reason,
          completedAt: new Date(),
        },
      });
      const row = await this.db.payment.findUnique({ where: { id: paymentId } });
      return row?.status.toLowerCase() ?? 'unknown';
    }
    let mirrored: Awaited<ReturnType<typeof postInTransaction>>['wallets'] = [];
    try {
      await this.db.$transaction(async (tx) => {
        // A payment the payer completed after we gave up on it (expired, failed) is still credited:
        // the money has been taken.
        const claimed = await tx.payment.updateMany({
          where: { id: paymentId, status: { not: 'SUCCEEDED' } },
          data: {
            status: 'SUCCEEDED',
            providerTxId: state.providerTxId,
            failureReason: null,
            completedAt: new Date(),
          },
        });
        if (claimed.count === 0) return;
        const payment = await tx.payment.findUniqueOrThrow({
          where: { id: paymentId },
          include: { organization: { select: { wallet: { select: { id: true } } } } },
        });
        const walletId = payment.organization.wallet?.id;
        if (!walletId) throw new Error(`organization ${payment.organizationId} has no wallet`);
        const amount = payment.amountUsd.toFixed(8);
        const posted = await postInTransaction(tx, {
          kind: 'topup',
          idempotencyKey: `payment:${payment.id}`,
          description: `${payment.provider} payment ${state.providerTxId}`,
          metadata: {
            paymentId: payment.id,
            provider: payment.provider,
            providerTxId: state.providerTxId,
            currency: payment.currency,
            amountMinor: payment.amountMinor.toString(),
          },
          legs: [
            { walletId, amountUsd: amount },
            { walletId: SYSTEM_WALLETS.funding, amountUsd: `-${amount}` },
          ],
        });
        await tx.payment.update({
          where: { id: paymentId },
          data: { transactionId: posted.transactionId },
        });
        mirrored = posted.wallets;
      });
    } catch (error) {
      throw ledgerProblem(error);
    }
    await this.wallets.mirror(mirrored);
    if (mirrored.length > 0) this.logger.info({ paymentId }, 'payment credited');
    return 'succeeded';
  }

  /**
   * Reconciliation: asks the provider about every payment still pending after two minutes.
   * One replica at a time (Valkey lock); everything it does is idempotent anyway.
   */
  async reconcileOnce(options: { now?: number; force?: boolean } = {}) {
    const now = options.now ?? Date.now();
    if (!options.force) {
      const locked = await this.valkey.client
        .set(RECONCILE_LOCK, '1', 'PX', RECONCILE_EVERY_MS - 10_000, 'NX')
        .catch(() => null);
      if (locked !== 'OK') return { checked: 0, skipped: true };
    }
    const pending = await this.db.payment.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(now - 2 * 60_000) } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const outcome: Record<string, number> = {};
    for (const payment of pending) {
      let state = await this.#confirm(payment);
      // Zarinpal refuses to verify an unpaid authority; only give up once it can no longer be paid.
      if (
        payment.provider === 'zarinpal' &&
        state.state === 'failed' &&
        now - payment.createdAt.getTime() < ZARINPAL_ABANDONED_MS
      )
        state = { state: 'pending' };
      if (payment.provider === 'zarinpal' && state.state === 'failed')
        state = { state: 'expired', reason: 'never verified' };
      const status = await this.settle(payment.id, state);
      outcome[status] = (outcome[status] ?? 0) + 1;
    }
    return { checked: pending.length, ...outcome };
  }
}
