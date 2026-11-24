/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { resetSessionForTests } from '../../lib/session';
import PaymentsPage from './payments';
import { type Call, captureDownloads, mockApi, renderPage, stubMatchMedia } from './test-kit';

stubMatchMedia();

const PAYMENTS = [
  {
    id: 'pay_1',
    organizationId: 'org_a',
    provider: 'zarinpal',
    status: 'succeeded',
    amountUsd: '10.00000000',
    currency: 'IRR',
    amountMinor: '10500000',
    exchangeRate: '1050000.00000000',
    providerTxId: 'A000123',
    failureReason: null,
    transactionId: 'txn_1',
    createdAt: '2026-11-20T10:00:00.000Z',
    completedAt: '2026-11-20T10:01:00.000Z',
  },
  {
    id: 'pay_2',
    organizationId: 'org_gone',
    provider: 'stripe',
    status: 'pending',
    amountUsd: '5.00000000',
    currency: 'USD',
    amountMinor: '500',
    exchangeRate: '1.00000000',
    providerTxId: null,
    failureReason: null,
    transactionId: null,
    createdAt: '2026-11-21T10:00:00.000Z',
    completedAt: null,
  },
];

const route = (call: Call) => {
  if (call.path === '/orgs/org_p/billing/wallets')
    return {
      status: 200,
      body: [
        {
          organizationId: 'org_a',
          name: 'Acme',
          slug: 'acme',
          prepaid: true,
          walletId: 'w',
          balanceUsd: '1',
        },
      ],
    };
  if (call.path === '/orgs/org_p/billing/payments')
    return {
      status: 200,
      body: call.query.status ? PAYMENTS.filter((p) => p.status === call.query.status) : PAYMENTS,
    };
  if (call.path === '/orgs/org_p/billing/payments/reconcile')
    return { status: 200, body: { checked: 3, succeeded: 1, expired: 2 } };
  return undefined;
};

describe('billing payments (card 25.1)', () => {
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

  it('lists payments with the customer, gateway, status and both amounts', async () => {
    mockApi(route);
    await renderPage(PaymentsPage);
    const rows = await screen.findAllByTestId('payment-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText('Acme')).toBeTruthy();
    expect(first.getByText('Zarinpal')).toBeTruthy();
    expect(first.getByText('Succeeded')).toBeTruthy();
    expect(first.getByText('A000123')).toBeTruthy();
    expect(first.getByText(/10,500,000/)).toBeTruthy();
    // An organization that is no longer listed still shows its ID.
    expect(within(rows[1] as HTMLElement).getByText('org_gone')).toBeTruthy();
  });

  it('filters by status on the server', async () => {
    const calls = mockApi(route);
    await renderPage(PaymentsPage);
    await screen.findAllByTestId('payment-row');
    fireEvent.click(screen.getByRole('radio', { name: 'Pending' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('payment-row')).toHaveLength(1);
    });
    expect(calls.some((c) => c.path.endsWith('/payments') && c.query.status === 'pending')).toBe(
      true,
    );
  });

  it('reconciles with the gateways and reports the outcome', async () => {
    const calls = mockApi(route);
    await renderPage(PaymentsPage);
    await screen.findAllByTestId('payment-row');
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile with gateways' }));
    const result = await screen.findByTestId('reconcile-result');
    expect(result.textContent).toBe('3 pending payments checked · Succeeded: 1 · Expired: 2');
    expect(calls.find((c) => c.path.endsWith('/reconcile'))?.method).toBe('POST');
  });

  it('exports the listed payments as CSV', async () => {
    mockApi(route);
    const files = captureDownloads();
    await renderPage(PaymentsPage);
    await screen.findAllByTestId('payment-row');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    const csv = await files[0]?.blob.text();
    expect(csv).toContain(
      '"pay_1","org_a","Acme","zarinpal","succeeded","10.00000000","IRR","10500000"',
    );
  });
});
