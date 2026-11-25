/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { resetSessionForTests } from '../../lib/session';
import CustomersPage from './customers';
import {
  type Call,
  captureDownloads,
  member,
  mockApi,
  renderPage,
  stubMatchMedia,
} from './test-kit';

stubMatchMedia();

const WALLETS = [
  {
    organizationId: 'org_a',
    name: 'Acme',
    slug: 'acme',
    prepaid: true,
    walletId: 'wal_a',
    balanceUsd: '25.50000000',
  },
  {
    organizationId: 'org_b',
    name: 'Beta',
    slug: 'beta',
    prepaid: false,
    walletId: null,
    balanceUsd: '0.00000001',
  },
];
const STATEMENT = [
  {
    id: 'ent_2',
    transactionId: 'txn_2',
    kind: 'usage',
    description: null,
    amountUsd: '-0.00012345',
    balanceAfterUsd: '25.50000000',
    createdAt: '2026-11-20T10:00:00.000Z',
  },
  {
    id: 'ent_1',
    transactionId: 'txn_1',
    kind: 'adjustment',
    description: 'bank transfer #77',
    amountUsd: '25.50012345',
    balanceAfterUsd: '25.50012345',
    createdAt: '2026-11-19T10:00:00.000Z',
  },
];

function api(
  adjust: (call: Call) => { status: number; body: unknown } = () => ({
    status: 201,
    body: { transactionId: 'txn_new', created: true },
  }),
) {
  return (call: Call) => {
    const p = call.path;
    if (p === '/orgs/org_p/billing/wallets') return { status: 200, body: WALLETS };
    if (p === '/orgs/org_p/billing/ledger/check')
      return {
        status: 200,
        body: { ok: true, totalUsd: '0.00000000', unbalancedTransactions: 0, driftedWallets: 0 },
      };
    if (p === '/orgs/org_p/billing/wallets/org_a' && call.method === 'GET')
      return {
        status: 200,
        body: {
          prepaid: true,
          wallet: {
            id: 'wal_a',
            balanceUsd: '25.50000000',
            heldUsd: '0.50000000',
            availableUsd: '25.00000000',
            updatedAt: '2026-11-20T10:00:00.000Z',
          },
        },
      };
    if (p === '/orgs/org_p/billing/wallets/org_a' && call.method === 'PATCH')
      return { status: 200, body: { prepaid: call.body?.prepaid, wallet: null } };
    if (p === '/orgs/org_p/billing/wallets/org_a/statement')
      return { status: 200, body: STATEMENT };
    if (p === '/orgs/org_p/billing/wallets/org_a/adjustments') return adjust(call);
    return undefined;
  };
}

async function openAcme() {
  fireEvent.click(await screen.findByRole('button', { name: 'Wallet of Acme' }));
  return screen.findByTestId('wallet-panel');
}

describe('billing customers and wallets (card 25.1)', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lists every customer with its balance and the exact total', async () => {
    mockApi(api());
    await renderPage(CustomersPage);
    const rows = await screen.findAllByTestId('customer-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Acme')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('Prepaid')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Postpaid')).toBeTruthy();
    // 25.5 + 0.00000001, not rounded away.
    expect(screen.getByText('$25.50000001')).toBeTruthy();
    expect(within(screen.getByTestId('ledger-check')).getByText('Balanced')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search name or ID' }), {
      target: { value: 'bet' },
    });
    expect(screen.getAllByTestId('customer-row')).toHaveLength(1);
  });

  it('shows the wallet and its statement with exact amounts, and exports it', async () => {
    mockApi(api());
    const files = captureDownloads();
    await renderPage(CustomersPage);
    const panel = await openAcme();
    expect(await within(panel).findByText('bank transfer #77')).toBeTruthy();
    const table = within(panel).getByTestId('statement-table');
    expect(table.querySelector('[data-exact="25.50012345"]')).toBeTruthy();
    expect(table.querySelector('[data-exact="-0.00012345"]')).toBeTruthy();
    expect(within(panel).getByTestId('wallet-heldUsd').textContent).toContain('0.50');
    fireEvent.click(within(panel).getByRole('button', { name: 'Export CSV' }));
    expect(files[0]?.name).toBe('dirouter-statement-acme.csv');
    const csv = await files[0]?.blob.text();
    expect(csv).toContain('"adjustment","bank transfer #77","25.50012345","25.50012345","txn_1"');
    // A debit keeps its minus sign: amounts are numbers, not formulas.
    expect(csv).toContain('"usage","","-0.00012345","25.50000000","txn_2"');
  });

  it('records a manual credit with the reason and one idempotency key per operation', async () => {
    const calls = mockApi(api());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage(CustomersPage);
    const panel = await openAcme();
    const form = within(panel).getByRole('form', { name: 'Manual credit or debit' });
    fireEvent.change(within(form).getByLabelText('Amount (USD)'), { target: { value: '25.5' } });
    fireEvent.change(within(form).getByLabelText('Reason'), {
      target: { value: 'bank transfer #77' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Record' }));
    expect(await within(form).findByText('Recorded (transaction txn_new).')).toBeTruthy();
    const posts = () =>
      calls.filter((c) => c.method === 'POST' && c.path.endsWith('/wallets/org_a/adjustments'));
    expect(posts()[0]?.body).toMatchObject({ amountUsd: '25.5', reason: 'bank transfer #77' });
    expect(confirm).toHaveBeenCalledWith('Add USD 25.5 to the wallet of Acme?');

    // A debit is the same form with the sign; it is a new operation with a new key.
    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'debit' } });
    fireEvent.change(within(form).getByLabelText('Amount (USD)'), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'correction' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(posts()).toHaveLength(2);
    });
    expect(posts()[1]?.body).toMatchObject({ amountUsd: '-5', reason: 'correction' });
    const keys = posts().map((c) => c.body?.idempotencyKey);
    expect(keys[0]).toMatch(/^dash-/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('refuses a missing reason or a bad amount before calling the API, and keeps the key on failure', async () => {
    const calls = mockApi(
      api(() => ({
        status: 402,
        body: { status: 402, code: 'insufficient_credit', detail: 'insufficient funds' },
      })),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage(CustomersPage);
    const panel = await openAcme();
    const form = within(panel).getByRole('form', { name: 'Manual credit or debit' });
    fireEvent.change(within(form).getByLabelText('Amount (USD)'), {
      target: { value: '1.123456789' },
    });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'ok reason' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record' }));
    expect(
      within(form).getByText('The amount must be a positive number with at most 8 decimals.'),
    ).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Amount (USD)'), { target: { value: '100' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'no' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record' }));
    expect(within(form).getByText('The reason needs at least 3 characters.')).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith('/adjustments'))).toBe(false);

    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'debit' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'too much' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record' }));
    expect(await within(form).findByText('insufficient funds')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Record' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.path.endsWith('/adjustments'))).toHaveLength(2);
    });
    const [first, retry] = calls.filter((c) => c.path.endsWith('/adjustments'));
    // A retry of the same refused operation reuses its key, so it can never post twice.
    expect(retry?.body?.idempotencyKey).toBe(first?.body?.idempotencyKey);
  });

  it('switches prepaid mode', async () => {
    const calls = mockApi(api());
    await renderPage(CustomersPage);
    const panel = await openAcme();
    const box = within(panel).getByRole('checkbox', { name: /Prepaid account/ });
    await waitFor(() => {
      expect((box as HTMLInputElement).disabled).toBe(false);
    });
    fireEvent.click(box);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ prepaid: false });
    });
  });

  it('is read-only without billing:write', async () => {
    const calls = mockApi(api(), member({ role: 'VIEWER', permissions: ['billing:read'] }));
    await renderPage(CustomersPage);
    const panel = await openAcme();
    const form = within(panel).getByRole('form', { name: 'Manual credit or debit' });
    expect(within(form).getByRole('button', { name: 'Record' }).matches(':disabled')).toBe(true);
    expect(
      within(panel).getByRole<HTMLInputElement>('checkbox', { name: /Prepaid account/ }).disabled,
    ).toBe(true);
    expect(calls.some((c) => c.method !== 'GET' && c.path.startsWith('/orgs'))).toBe(false);
  });
});
