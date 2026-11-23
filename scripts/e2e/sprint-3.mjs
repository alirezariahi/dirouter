/* eslint-disable no-console */
/**
 * Sprint 3 end-to-end checks against the development stack (make up && make seed). Every scenario
 * goes through Traefik like a client would and names the board card it verifies.
 *
 *   node scripts/e2e/sprint-3.mjs            # everything
 *   node scripts/e2e/sprint-3.mjs 19.1 19.3  # only scenarios whose name contains one of these
 *
 * The operator is the seed admin on the platform organization (org_dev). Billing scenarios use a
 * customer organization, `org_s3_customer`, kept between runs (its ledger is append-only) with its
 * own mock provider, model, project and key.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  adminClient,
  chat,
  request,
  createRunner,
  login,
  published,
  readEnv,
  skip,
  sql,
  urls,
  valkey,
  waitFor,
} from './harness.mjs';

const PLATFORM = 'org_dev';
const CUSTOMER = 'org_s3_customer';
const { scenario, cleanups, finish } = createRunner();

/** Customer organization with the seed admin as its owner, a mock-backed model and a key. */
async function customerFixture(api, adminUserId) {
  await sql(`INSERT INTO organizations (id, name, slug, updated_at)
             VALUES ('${CUSTOMER}', 'Sprint 3 customer', 's3-customer', now()) ON CONFLICT DO NOTHING;
             INSERT INTO memberships (id, user_id, organization_id, role)
             VALUES ('mem_s3_customer', '${adminUserId}', '${CUSTOMER}', 'OWNER') ON CONFLICT DO NOTHING`);
  const cust = (method, path, body, expected) =>
    api(method, `orgs/${CUSTOMER}/${path}`, body, expected);
  const providers = (await cust('GET', 'providers')).body;
  const models = (await cust('GET', 'models')).body;
  /** A mock-backed provider and its model; the credential carries the mock's directives. */
  const ensureModel = async (slug, secret) => {
    let provider = (providers.items ?? providers).find((p) => p.slug === slug);
    if (!provider)
      provider = (
        await cust(
          'POST',
          'providers',
          {
            name: slug,
            slug,
            type: 'openai-compatible',
            baseUrl: 'http://mock-provider:8090/v1',
            credentials: [{ name: 'k', secret }],
          },
          201,
        )
      ).body;
    const modelSlug = `s3/${slug.replace('s3-', '')}`;
    return (
      (models.items ?? models).find((m) => m.slug === modelSlug) ??
      (
        await cust(
          'POST',
          'models',
          {
            providerId: provider.id,
            upstreamModel: 'mock-small',
            slug: modelSlug,
            // $100 per million tokens: one short request costs a fraction of a cent.
            pricing: { inputPerMTok: '100', outputPerMTok: '100' },
          },
          201,
        )
      ).body
    );
  };
  const model = await ensureModel('s3-small', 'sk-mock');
  // Answers after 1.5 s, so concurrent requests really overlap.
  await ensureModel('s3-slow', 'mock:latency=1500');
  const projects = (await cust('GET', 'projects')).body;
  let project = (projects.items ?? projects).find((p) => p.slug === 's3-default');
  if (!project)
    project = (await cust('POST', 'projects', { name: 'S3 default', slug: 's3-default' }, 201))
      .body;
  const key = (
    await published(() =>
      cust(
        'POST',
        'keys',
        { name: `s3-e2e-${randomUUID().slice(0, 8)}`, projectId: project.id },
        201,
      ),
    )
  ).body;
  cleanups.push(() => cust('POST', `keys/${key.id}/revoke`, undefined, null));
  return { cust, model, key };
}

/** Ends the customer's plan at once (the API only cancels at period end) and its allowance. */
async function endPlan() {
  await sql(`UPDATE subscriptions SET status = 'cancelled' WHERE organization_id = '${CUSTOMER}'`);
  const wallet = await sql(`SELECT id FROM wallets WHERE organization_id = '${CUSTOMER}'`);
  if (wallet) await valkey('HSET', `dirouter:wallet:{${wallet}}`, 'quota', '0');
}

let crashed = false;
try {
  const seedAdmin = await readEnv('.data/seed-admin.env');
  const api = adminClient(await login(seedAdmin.SEED_ADMIN_EMAIL, seedAdmin.SEED_ADMIN_PASSWORD));
  const me = (await api('GET', 'auth/me')).body;
  const operator = (method, path, body, expected) =>
    api(method, `orgs/${PLATFORM}/${path}`, body, expected);
  const customer = await customerFixture(api, me.id);
  /** Prepaid on or off; waits for the snapshot only when something changes. */
  const setPrepaid = async (prepaid) => {
    const now = (await operator('GET', `billing/wallets/${CUSTOMER}`)).body.prepaid;
    if (now !== prepaid)
      await published(() => operator('PATCH', `billing/wallets/${CUSTOMER}`, { prepaid }));
  };

  // ───────────── Epic 19: billing ─────────────

  await scenario(
    '19.1 prepaid wallet: reservation, debit, no overdraft, balanced ledger',
    async () => {
      await endPlan();
      const wallet = async () => (await operator('GET', `billing/wallets/${CUSTOMER}`)).body;
      const adjust = (amountUsd, reason) =>
        operator(
          'POST',
          `billing/wallets/${CUSTOMER}/adjustments`,
          {
            amountUsd,
            reason,
            idempotencyKey: randomUUID(),
          },
          201,
        );
      await setPrepaid(true);
      cleanups.push(() => setPrepaid(false));
      // Start from an empty wallet (the organization is kept between runs).
      const start = (await wallet()).wallet;
      if (start.balanceUsd !== '0.00000000') await adjust(`-${start.balanceUsd}`, 'e2e reset');
      const ask = (max = 50, slow = false) =>
        chat(customer.key.key, {
          model: slow ? 's3/slow' : 's3/small',
          max_tokens: max,
          messages: [{ role: 'user', content: 'hello wallet' }],
        });

      const empty = await ask();
      assert.equal(empty.response.status, 402, empty.text);
      assert.equal(empty.body.error.code, 'insufficient_credit');

      await adjust('0.05', 'e2e credit');
      const ok = await ask();
      assert.equal(ok.response.status, 200, ok.text);
      const requestId = ok.response.headers.get('x-request-id');
      const debit = await waitFor('the usage debit', async () => {
        const row = await sql(`SELECT e.amount_usd FROM wallet_entries e
        JOIN wallet_transactions t ON t.id = e.transaction_id
        WHERE t.idempotency_key = 'usage:${requestId}' AND e.wallet_id = '${start.id}'`);
        return row === '' ? undefined : row;
      });
      const cost = await sql(`SELECT cost_usd FROM request_log WHERE id = '${requestId}'`);
      assert.equal(Number(debit), -Number(cost), 'the wallet is debited the request cost');
      const after = (await wallet()).wallet;
      assert.equal(Number(after.balanceUsd), Number((0.05 + Number(debit)).toFixed(8)));
      await waitFor(
        'the reservation to be released',
        async () => (await valkey('HLEN', `dirouter:wallet:{${start.id}}:holds`)) === '0',
      );

      // 30 concurrent requests, each reserving up to 1000 output tokens ($0.1) against $0.25:
      // only what the balance covers is admitted, and the balance never goes below zero.
      await adjust((0.25 - Number(after.balanceUsd)).toFixed(8), 'e2e top-up to 0.25');
      const burst = await Promise.all(Array.from({ length: 30 }, () => ask(1000, true)));
      const statuses = burst.map((r) => r.response.status);
      assert.equal(statuses.filter((s) => s === 200).length, 2, `two admitted: ${statuses}`);
      assert.equal(statuses.filter((s) => s === 402).length, 28, `the rest refused: ${statuses}`);
      await waitFor('all debits', async () => {
        const ids = burst
          .filter((r) => r.response.status === 200)
          .map((r) => `'usage:${r.response.headers.get('x-request-id')}'`);
        return (
          (await sql(
            `SELECT count(*) FROM wallet_transactions WHERE idempotency_key IN (${ids})`,
          )) === String(ids.length)
        );
      });
      const final = (await wallet()).wallet;
      assert.ok(Number(final.balanceUsd) >= 0, `balance ${final.balanceUsd}`);
      const negative = await sql(
        `SELECT count(*) FROM wallet_entries WHERE wallet_id = '${start.id}' AND balance_after < 0`,
      );
      assert.equal(negative, '0');
      const check = (await operator('GET', 'billing/ledger/check')).body;
      assert.deepEqual(check, {
        totalUsd: '0.00000000',
        unbalancedTransactions: 0,
        driftedWallets: 0,
        ok: true,
      });
    },
  );

  await scenario(
    '19.2 top-ups: Zarinpal and Stripe credit once, failures change nothing',
    async () => {
      const original = (await operator('GET', 'billing/settings')).body;
      cleanups.push(() =>
        operator('PUT', 'billing/settings', {
          exchangeRates: original.exchangeRates,
          topup: original.topup,
          providers: original.providers,
        }),
      );
      await operator('PUT', 'billing/settings', {
        exchangeRates: { IRR: '1050000' },
        topup: { minUsd: '1', maxUsd: '500' },
        providers: ['zarinpal', 'stripe'],
      });
      const options = (await customer.cust('GET', 'wallet/payment-options')).body;
      assert.deepEqual(options.providers, ['zarinpal', 'stripe']);
      const paid = [];
      /** Credit posted by this scenario's payments (usage debits from 19.1 may still land). */
      const credited = async () =>
        Number(
          await sql(`SELECT COALESCE(sum(e.amount_usd), 0) FROM wallet_entries e
            JOIN wallet_transactions t ON t.id = e.transaction_id
            JOIN wallets w ON w.id = e.wallet_id AND w.organization_id = '${CUSTOMER}'
            WHERE t.idempotency_key IN (${paid.map((id) => `'payment:${id}'`).join(',')})`),
        );
      const pay = async (provider, amountUsd) =>
        (await customer.cust('POST', 'wallet/payments', { provider, amountUsd }, 201)).body;
      const track = (payment) => {
        paid.push(payment.paymentId);
        return payment;
      };
      // The payer's browser: the provider page, then our callback, then the return page.
      const follow = async (url) => {
        const page = await fetch(url.replace('http://mock-provider:8090', urls.mock), {
          redirect: 'manual',
        });
        const callback = page.headers.get('location');
        const landing = await fetch(callback, { redirect: 'manual' });
        return { callback, landing: new URL(landing.headers.get('location')) };
      };

      // Zarinpal: paid, then the callback replayed three times at once.
      const zp = track(await pay('zarinpal', '3'));
      const zpRun = await follow(zp.redirectUrl);
      assert.equal(zpRun.landing.searchParams.get('status'), 'succeeded');
      await Promise.all([1, 2, 3].map(() => fetch(zpRun.callback, { redirect: 'manual' })));
      assert.equal(await credited(), 3);
      const zpRow = (await customer.cust('GET', `wallet/payments/${zp.paymentId}`)).body;
      assert.equal(zpRow.amountMinor, '3150000');
      assert.equal(
        await sql(
          `SELECT count(*) FROM wallet_transactions WHERE idempotency_key = 'payment:${zp.paymentId}'`,
        ),
        '1',
      );

      // Zarinpal: cancelled by the payer.
      const failed = track(await pay('zarinpal', '4'));
      const failedRun = await follow(`${failed.redirectUrl}?result=NOK`);
      assert.equal(failedRun.landing.searchParams.get('status'), 'failed');
      assert.equal(await credited(), 3);

      // Stripe: the signed webhook (sent by the fake Stripe) credits; the return page agrees.
      const st = track(await pay('stripe', '5'));
      const stRun = await follow(st.redirectUrl);
      assert.equal(stRun.landing.searchParams.get('status'), 'succeeded');
      assert.equal(await credited(), 8);

      // Stripe: the webhook is lost and the payer never comes back; reconciliation credits it.
      const lost = track(await pay('stripe', '2'));
      await fetch(`${lost.redirectUrl}?webhook=none`, { redirect: 'manual' });
      await sql(
        `UPDATE payments SET created_at = now() - interval '10 minutes' WHERE id = '${lost.paymentId}'`,
      );
      const reconciled = (await operator('POST', 'billing/payments/reconcile')).body;
      assert.ok(reconciled.succeeded >= 1, JSON.stringify(reconciled));
      assert.equal(await credited(), 10);

      const check = (await operator('GET', 'billing/ledger/check')).body;
      assert.equal(check.ok, true, JSON.stringify(check));
    },
  );
  await scenario(
    '19.3 gift codes: each code only up to its cap, shown once, reported',
    async () => {
      const created = (
        await operator(
          'POST',
          'billing/gift-batches',
          { name: `e2e ${new Date().toISOString()}`, kind: 'gift', amountUsd: '1.5', count: 2 },
          201,
        )
      ).body;
      assert.equal(created.codes.length, 2);
      const [first, second] = created.codes;
      const redeem = (code, expected) => customer.cust('POST', 'wallet/redeem', { code }, expected);
      const ok = (await redeem(first.toLowerCase(), 200)).body;
      assert.equal(ok.amountUsd, '1.50000000');
      await redeem(first, 409);
      // A multi-use code shared by organizations: the platform cannot redeem; the cap holds.
      const shared = (
        await operator(
          'POST',
          'billing/gift-batches',
          { name: 'e2e shared', kind: 'recharge', amountUsd: '0.5', count: 1, maxRedemptions: 1 },
          201,
        )
      ).body.codes[0];
      await redeem(shared, 200);
      await redeem(shared, 409);
      const report = (await operator('GET', `billing/gift-batches/${created.id}`)).body;
      assert.equal(report.redemptions, 1);
      assert.equal(report.creditedUsd, '1.50000000');
      assert.equal(report.codes, 2);
      assert.equal('codes' in report && Array.isArray(report.codes), false);
      const rows = (await operator('GET', `billing/gift-batches/${created.id}/redemptions`)).body;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].organizationId, CUSTOMER);
      // Only an HMAC and a 7-character hint are stored, never the code itself.
      assert.equal(
        await sql(`SELECT count(*) FROM gift_codes WHERE batch_id = '${created.id}'
          AND code_hash ~ '^[0-9a-f]{64}$' AND length(hint) = 7
          AND hint || '-' NOT IN ('${first}', '${second}')`),
        '2',
      );
      await operator('POST', `billing/gift-batches/${created.id}/revoke`);
      await redeem(second, 422);
      assert.equal((await operator('GET', 'billing/ledger/check')).body.ok, true);
    },
  );
  await scenario(
    '19.4 sale pricing: multipliers apply live, marketplace, plan allowance',
    async () => {
      const platformModel = (await operator('GET', 'models')).body;
      const mockSmall = (platformModel.items ?? platformModel).find((m) => m.slug === 'mock/small');
      assert.ok(mockSmall, 'seeded platform model mock/small');
      const restore = { isPublic: mockSmall.isPublic, sale: { ...mockSmall.sale } };
      cleanups.push(() => published(() => operator('PATCH', `models/${mockSmall.id}`, restore)));
      const priced = (patch) => published(() => operator('PATCH', `models/${mockSmall.id}`, patch));
      const ask = async () => {
        const r = await chat(customer.key.key, {
          model: 'mock/small',
          max_tokens: 20,
          messages: [{ role: 'user', content: `price check ${randomUUID()}` }],
        });
        return r;
      };
      /** cost and charge of a request, once the worker has written it. */
      const amounts = async (response) => {
        const id = response.headers.get('x-request-id');
        const row = await waitFor(`request_log ${id}`, async () => {
          const out = await sql(`SELECT cost_usd, charge_usd FROM request_log WHERE id = '${id}'`);
          return out === '' ? undefined : out;
        });
        const [cost, charge] = row.split('|').map(Number);
        return { cost, charge };
      };

      // Private platform models are invisible to customers.
      if (mockSmall.isPublic) await priced({ isPublic: false });
      assert.equal((await ask()).response.status, 404);

      // Published at twice the cost.
      await priced({
        isPublic: true,
        sale: { multiplier: '2', perRequestUsd: null, cacheMultiplier: '0' },
      });
      const first = await ask();
      assert.equal(first.response.status, 200, first.text);
      const a = await amounts(first.response);
      assert.ok(a.cost > 0);
      assert.equal(a.charge, Number((a.cost * 2).toFixed(8)));

      // A new multiplier applies to the next request, without any deploy.
      await priced({ sale: { multiplier: '3' } });
      const b = await amounts((await ask()).response);
      assert.equal(b.charge, Number((b.cost * 3).toFixed(8)));

      // Customer group: everything for this organization at half price.
      const group = (
        await operator(
          'POST',
          'billing/groups',
          { name: `e2e ${randomUUID()}`, multiplier: '0.5' },
          201,
        )
      ).body;
      // Unassigned below, so deleting it changes no snapshot.
      cleanups.push(() => operator('DELETE', `billing/groups/${group.id}`, undefined, 204));
      await published(() =>
        operator('PUT', `billing/wallets/${CUSTOMER}/group`, { customerGroupId: group.id }),
      );
      const c = await amounts((await ask()).response);
      assert.equal(c.charge, Number((c.cost * 1.5).toFixed(8)));

      // Fixed price per request (images, video): tokens no longer matter.
      await priced({ sale: { perRequestUsd: '0.02' } });
      const d = await amounts((await ask()).response);
      assert.equal(d.charge, 0.01);

      // A plan: the allowance pays first, the wallet stays untouched.
      await priced({ sale: { multiplier: '1', perRequestUsd: null } });
      await published(() =>
        operator('PUT', `billing/wallets/${CUSTOMER}/group`, { customerGroupId: null }),
      );
      await setPrepaid(true);
      cleanups.push(() => setPrepaid(false));
      await operator(
        'POST',
        `billing/wallets/${CUSTOMER}/adjustments`,
        { amountUsd: '1', reason: 'e2e plan credit', idempotencyKey: randomUUID() },
        201,
      );
      const plan = (
        await operator(
          'POST',
          'billing/plans',
          { name: `e2e ${randomUUID()}`, priceUsd: '0.5', includedUsd: '0.2' },
          201,
        )
      ).body;
      cleanups.push(endPlan);
      cleanups.push(() => operator('PATCH', `billing/plans/${plan.id}`, { active: false }, null));
      const before = Number((await customer.cust('GET', 'wallet')).body.wallet.balanceUsd);
      const sub = (await customer.cust('POST', 'wallet/subscription', { planId: plan.id }, 201))
        .body;
      assert.equal(sub.remainingUsd, '0.20000000');
      const afterFee = Number((await customer.cust('GET', 'wallet')).body.wallet.balanceUsd);
      assert.equal(Number((before - afterFee).toFixed(8)), 0.5);
      const e = await ask();
      assert.equal(e.response.status, 200, e.text);
      const used = await amounts(e.response);
      await waitFor('the allowance to be used', async () => {
        const now = (await customer.cust('GET', 'wallet/subscription')).body;
        return Number(now.usedUsd) === used.charge;
      });
      assert.equal(Number((await customer.cust('GET', 'wallet')).body.wallet.balanceUsd), afterFee);
    },
  );
  await scenario(
    '19.5 portal: a new user goes from sign-up to the first request alone',
    async () => {
      const portal = 'http://portal.localhost';
      const page = await request(`${portal}/app/billing`, {}, 200);
      assert.match(page.text, /<div id="root"><\/div>/);

      // The operator opens sign-up with a welcome credit and publishes one model.
      const original = (await operator('GET', 'billing/settings')).body;
      const restoreSettings = {
        exchangeRates: original.exchangeRates,
        topup: original.topup,
        providers: original.providers,
        portal: original.portal,
      };
      cleanups.push(() => operator('PUT', 'billing/settings', restoreSettings));
      await operator('PUT', 'billing/settings', {
        ...restoreSettings,
        exchangeRates: { IRR: '1000000' },
        providers: ['zarinpal'],
        portal: { signupEnabled: true, welcomeCreditUsd: '1' },
      });
      const models = (await operator('GET', 'models')).body;
      const mockSmall = (models.items ?? models).find((m) => m.slug === 'mock/small');
      if (!mockSmall.isPublic) {
        await published(() => operator('PATCH', `models/${mockSmall.id}`, { isPublic: true }));
        cleanups.push(() =>
          published(() => operator('PATCH', `models/${mockSmall.id}`, { isPublic: false })),
        );
      }
      await valkey(
        'EVAL',
        "for _, k in ipairs(redis.call('KEYS', 'portal:signups:*')) do redis.call('DEL', k) end",
        '0',
      );

      // Everything below is the new user alone, from the portal's origin.
      const market = (await request(`${urls.admin}/api/v1/portal/market`, {}, 200)).body;
      assert.ok(market.models.some((m) => m.slug === 'mock/small'));
      const email = `s3-portal-${randomUUID().slice(0, 8)}@example.com`;
      const signup = await request(
        `${urls.admin}/api/v1/portal/signup`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: portal },
          body: JSON.stringify({ name: 'Portal User', email, password: 'portal-e2e-password' }),
        },
        201,
      );
      assert.equal(signup.response.headers.get('access-control-allow-origin'), portal);
      const user = adminClient(signup.body.accessToken);
      const me = (await user('GET', 'auth/me')).body;
      assert.equal(me.organizations.length, 1);
      const org = me.organizations[0].id;
      cleanups.push(() => sql(`UPDATE organizations SET deleted_at = now() WHERE id = '${org}'`));
      const wallet = async () =>
        Number((await user('GET', `orgs/${org}/wallet`)).body.wallet.balanceUsd);
      assert.equal(await wallet(), 1);
      const project = (await user('GET', `orgs/${org}/projects`)).body.find(
        (p) => p.slug === 'default',
      );
      const key = (
        await published(() =>
          user('POST', `orgs/${org}/keys`, { name: 'first', projectId: project.id }, 201),
        )
      ).body;
      await waitFor('the gateway to know the new key', async () => {
        const probe = await fetch(`${urls.gateway}/v1/models`, {
          headers: { authorization: `Bearer ${key.key}` },
        });
        return probe.status === 200 && (await probe.json()).data.some((m) => m.id === 'mock/small');
      });
      const first = await chat(key.key, {
        model: 'mock/small',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'my first request' }],
      });
      assert.equal(first.response.status, 200, first.text);
      await waitFor('the first request to be charged', async () => (await wallet()) < 1);

      // Topping up needs no operator either (fake Zarinpal, as in 19.2).
      const payment = (
        await user(
          'POST',
          `orgs/${org}/wallet/payments`,
          { provider: 'zarinpal', amountUsd: '2', returnUrl: `${portal}/app/billing` },
          201,
        )
      ).body;
      const gateway = await fetch(
        payment.redirectUrl.replace('http://mock-provider:8090', urls.mock),
        {
          redirect: 'manual',
        },
      );
      const landing = await fetch(gateway.headers.get('location'), { redirect: 'manual' });
      const back = new URL(landing.headers.get('location'));
      assert.equal(back.origin, portal);
      assert.equal(back.searchParams.get('status'), 'succeeded');
      assert.ok((await wallet()) > 2.9);
    },
  );
  await scenario('19.6 invoices and profit: the invoice equals the ledger', async () => {
    // Month to date for the customer, compared with the ledger rows themselves.
    const preview = (await customer.cust('GET', 'invoices/preview')).body;
    assert.equal(preview.basis, 'prepaid');
    const wallet = (await customer.cust('GET', 'wallet')).body.wallet;
    const monthStart = `${preview.period}-01`;
    const [opening, movement, usageEntries] = (
      await sql(`SELECT
          COALESCE(SUM(e.amount_usd) FILTER (WHERE e.created_at < '${monthStart}'), 0),
          COALESCE(SUM(e.amount_usd) FILTER (WHERE e.created_at >= '${monthStart}'), 0),
          COALESCE(SUM(e.amount_usd) FILTER (WHERE e.created_at >= '${monthStart}' AND t.kind = 'usage'), 0)
        FROM wallet_entries e JOIN wallet_transactions t ON t.id = e.transaction_id
        WHERE e.wallet_id = '${wallet.id}'`)
    )
      .split('|')
      .map(Number);
    assert.equal(Number(preview.openingUsd), opening);
    assert.equal(Number(preview.closingUsd), Number((opening + movement).toFixed(8)));
    assert.equal(Number(preview.closingUsd), Number(wallet.balanceUsd));
    const totals = Object.values(preview.totals).reduce((sum, v) => sum + Number(v), 0);
    assert.equal(Number(totals.toFixed(8)), Number(movement.toFixed(8)));
    const lines = preview.lines.reduce((sum, l) => sum + Number(l.amountUsd), 0);
    assert.equal(Number(lines.toFixed(8)), Number((-usageEntries).toFixed(8)));

    // Profit today: cost against sales by model, with the totals adding up.
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    // The rollup is refreshed by the worker; wait for today's sales to show up.
    const report = await waitFor(
      'today in the profit report',
      async () => {
        const r = (await operator('GET', `billing/reports/profit?from=${today}&to=${tomorrow}`))
          .body;
        return r.models.length > 0 ? r : undefined;
      },
      120_000,
    );
    const cost = report.models.reduce((sum, m) => sum + Number(m.costUsd), 0);
    const revenue = report.models.reduce((sum, m) => sum + Number(m.revenueUsd), 0);
    assert.equal(Number(report.totals.costUsd), Number(cost.toFixed(8)));
    assert.equal(Number(report.totals.revenueUsd), Number(revenue.toFixed(8)));
    assert.ok(Number(report.ledger.revenueBookedUsd) > 0);

    // The monthly run (also scheduled in the worker) is idempotent.
    const last = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 7);
    const run = (await operator('POST', `billing/invoices/generate?period=${last}`)).body;
    const rerun = (await operator('POST', `billing/invoices/generate?period=${last}`)).body;
    assert.equal(rerun.created, 0);
    assert.equal(rerun.organizations, run.organizations);
  });
  await scenario(
    '20.1 MCP gateway: Claude Code connects, the allowlist hides tools, calls are logged',
    async () => {
      // Fake MCP servers in mock-provider: Streamable HTTP and the older HTTP+SSE transport.
      const servers = [];
      for (const body of [
        {
          name: 'Demo',
          slug: `s3demo`,
          url: 'http://mock-provider:8090/mcp/demo',
          forwardIdentity: true,
        },
        {
          name: 'Legacy',
          slug: `s3legacy`,
          transport: 'sse',
          url: 'http://mock-provider:8090/mcp-legacy/old',
        },
      ]) {
        const existing = (await operator('GET', 'mcp/servers')).body.find(
          (x) => x.slug === body.slug,
        );
        if (existing) await operator('DELETE', `mcp/servers/${existing.id}`, undefined, 204);
        servers.push((await published(() => operator('POST', 'mcp/servers', body, 201))).body);
      }
      cleanups.push(async () => {
        for (const server of servers)
          await operator('DELETE', `mcp/servers/${server.id}`, undefined, null);
      });
      const key = (
        await published(() =>
          operator(
            'POST',
            'keys',
            {
              name: `s3-mcp-${randomUUID().slice(0, 8)}`,
              projectId: 'prj_dev',
              mcpTools: ['s3demo__echo', 's3demo__whoami', 's3legacy__*'],
            },
            201,
          ),
        )
      ).body;
      cleanups.push(() => operator('POST', `keys/${key.id}/revoke`, undefined, null));
      const mcp = async (method, params, id = 1) =>
        (
          await request(
            `${urls.gateway}/mcp`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${key.key}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
              },
              body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
            },
            200,
          )
        ).body;
      const tools = await waitFor('the gateway to list the MCP tools', async () => {
        const list = (await mcp('tools/list')).result.tools.map((t) => t.name).sort();
        return list.length > 0 ? list : undefined;
      });
      assert.deepEqual(tools, [
        's3demo__echo',
        's3demo__whoami',
        's3legacy__add',
        's3legacy__echo',
        's3legacy__fail',
        's3legacy__whoami',
      ]);
      const echo = await mcp('tools/call', {
        name: 's3demo__echo',
        arguments: { text: 'hello', token: 'secret-value' },
      });
      assert.equal(echo.result.content[0].text, 'hello');
      const legacy = await mcp('tools/call', {
        name: 's3legacy__add',
        arguments: { a: 20, b: 22 },
      });
      assert.equal(legacy.result.content[0].text, '42');
      const whoami = await mcp('tools/call', { name: 's3demo__whoami', arguments: {} });
      assert.deepEqual(JSON.parse(whoami.result.content[0].text), {
        'x-dirouter-organization-id': 'org_dev',
        'x-dirouter-project-id': 'prj_dev',
        'x-dirouter-key-id': key.id,
      });
      const denied = await mcp('tools/call', { name: 's3demo__add', arguments: { a: 1, b: 1 } });
      assert.equal(denied.error.code, -32602);

      // The worker writes every call; arguments are masked.
      const logged = await waitFor('the tool calls in the log', async () => {
        const calls = (await operator('GET', `mcp/calls?apiKeyId=${key.id}`)).body;
        return calls.length >= 4 ? calls : undefined;
      });
      assert.deepEqual(logged.map((c) => `${c.tool}:${c.status}`).sort(), [
        'add:denied',
        'add:success',
        'echo:success',
        'whoami:success',
      ]);
      const echoCall = logged.find((c) => c.tool === 'echo');
      assert.deepEqual(echoCall.arguments, { text: 'hello', token: '***' });

      // Claude Code itself: `claude mcp add` against the gateway, then its health check.
      const claude = await new Promise((done) => {
        execFile('claude', ['--version'], (error) => done(!error));
      });
      if (!claude) skip('Claude Code CLI is not installed');
      // A throwaway Claude Code configuration: nothing is written to the user's own.
      const dir = await mkdtemp(join(tmpdir(), 'dirouter-claude-mcp-'));
      const run = (args) =>
        new Promise((done, fail) => {
          execFile(
            'claude',
            args,
            {
              cwd: dir,
              timeout: 90_000,
              env: { ...process.env, CLAUDE_CONFIG_DIR: join(dir, 'config') },
            },
            (error, stdout, stderr) =>
              error ? fail(new Error(`${error.message}\n${stderr}`)) : done(stdout),
          );
        });
      await run([
        'mcp',
        'add',
        '--scope',
        'user',
        '--transport',
        'http',
        'dirouter',
        `${urls.gateway}/mcp`,
        '--header',
        `Authorization: Bearer ${key.key}`,
      ]);
      const listed = await run(['mcp', 'list']);
      console.log(
        `     claude mcp list: ${listed
          .trim()
          .split('\n')
          .filter((l) => l.includes('dirouter'))
          .join(' ')}`,
      );
      assert.match(listed, /dirouter: .*\/mcp \(HTTP\) - [✓✔] Connected/);
    },
  );
} catch (error) {
  crashed = true;
  console.error(error);
} finally {
  await finish(crashed);
}
