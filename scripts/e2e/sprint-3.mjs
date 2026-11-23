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
import { randomUUID } from 'node:crypto';

import {
  adminClient,
  chat,
  createRunner,
  login,
  published,
  readEnv,
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

let crashed = false;
try {
  const seedAdmin = await readEnv('.data/seed-admin.env');
  const api = adminClient(await login(seedAdmin.SEED_ADMIN_EMAIL, seedAdmin.SEED_ADMIN_PASSWORD));
  const me = (await api('GET', 'auth/me')).body;
  const operator = (method, path, body, expected) =>
    api(method, `orgs/${PLATFORM}/${path}`, body, expected);
  const customer = await customerFixture(api, me.id);

  // ───────────── Epic 19: billing ─────────────

  await scenario(
    '19.1 prepaid wallet: reservation, debit, no overdraft, balanced ledger',
    async () => {
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
      await published(() => operator('PATCH', `billing/wallets/${CUSTOMER}`, { prepaid: true }));
      cleanups.push(() =>
        published(() => operator('PATCH', `billing/wallets/${CUSTOMER}`, { prepaid: false })),
      );
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
} catch (error) {
  crashed = true;
  console.error(error);
} finally {
  await finish(crashed);
}
