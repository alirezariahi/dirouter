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
  let provider = (await cust('GET', 'providers')).body.find?.((p) => p.slug === 's3-mock');
  if (!provider)
    provider = (
      await cust(
        'POST',
        'providers',
        {
          name: 'S3 mock',
          slug: 's3-mock',
          type: 'openai-compatible',
          baseUrl: 'http://mock-provider:8090/v1',
          credentials: [{ name: 'k', secret: 'sk-mock' }],
        },
        201,
      )
    ).body;
  const models = (await cust('GET', 'models')).body;
  let model = (models.items ?? models).find((m) => m.slug === 's3/small');
  if (!model)
    model = (
      await cust(
        'POST',
        'models',
        {
          providerId: provider.id,
          upstreamModel: 'mock-small',
          slug: 's3/small',
          // $100 per million tokens: one short request costs a fraction of a cent.
          pricing: { inputPerMTok: '100', outputPerMTok: '100' },
        },
        201,
      )
    ).body;
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
      const ask = (max = 50) =>
        chat(customer.key.key, {
          model: 's3/small',
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
      const burst = await Promise.all(Array.from({ length: 30 }, () => ask(1000)));
      const statuses = burst.map((r) => r.response.status);
      assert.ok(statuses.filter((s) => s === 200).length >= 2, `some admitted: ${statuses}`);
      assert.ok(statuses.filter((s) => s === 402).length >= 20, `most refused: ${statuses}`);
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
} catch (error) {
  crashed = true;
  console.error(error);
} finally {
  await finish(crashed);
}
