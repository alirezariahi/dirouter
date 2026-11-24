/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { resetSessionForTests } from '../../lib/session';
import InvoicesPage from './invoices';
import { type Call, captureDownloads, mockApi, renderPage, stubMatchMedia } from './test-kit';

stubMatchMedia();

const invoice = (id: string, number: string, period: string) => ({
  id,
  number,
  organizationId: 'org_a',
  period,
  basis: 'prepaid',
  openingUsd: '0.00000000',
  closingUsd: '18.62500000',
  totals: { topup: '20.00000000', usage: '-4.37500000' },
  lines: [{ model: 'shop/fast', requests: 2, amountUsd: '1.25000000' }],
  createdAt: '2026-11-01T00:00:00.000Z',
});
const PDF = '%PDF-1.4 test';

const route = (call: Call) => {
  const base = '/orgs/org_p/billing/invoices';
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
  if (call.path === base)
    return {
      status: 200,
      body:
        call.query.period === '2026-09'
          ? [invoice('inv_0', 'INV-2026-000001', '2026-09')]
          : [
              invoice('inv_1', 'INV-2026-000002', '2026-10'),
              invoice('inv_0', 'INV-2026-000001', '2026-09'),
            ],
    };
  if (call.path === `${base}/inv_1/verify`)
    return { status: 200, body: { ok: true, problems: [] } };
  if (call.path === `${base}/inv_0/verify`)
    return { status: 200, body: { ok: false, problems: ['closing balance'] } };
  if (call.path === `${base}/inv_1/pdf`) return { status: 200, body: PDF, type: 'application/pdf' };
  if (call.path === `${base}/generate`)
    return {
      status: 200,
      body: { period: call.query.period, organizations: 3, created: 1 },
    };
  return undefined;
};

describe('billing invoices (card 25.2)', () => {
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

  it('lists invoices with the customer and filters by month', async () => {
    const calls = mockApi(route);
    await renderPage(InvoicesPage);
    const rows = await screen.findAllByTestId('invoice-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('INV-2026-000002')).toBeTruthy();
    expect(await within(rows[0] as HTMLElement).findByText('Acme')).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Month')[0] as HTMLElement, {
      target: { value: '2026-09' },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('invoice-row')).toHaveLength(1);
    });
    expect(calls.some((c) => c.path.endsWith('/invoices') && c.query.period === '2026-09')).toBe(
      true,
    );
  });

  it('verifies an invoice against the ledger and shows what differs', async () => {
    mockApi(route);
    await renderPage(InvoicesPage);
    await screen.findAllByTestId('invoice-row');
    fireEvent.click(screen.getByRole('button', { name: 'Verify INV-2026-000002' }));
    expect(await screen.findByText('Matches the ledger')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verify INV-2026-000001' }));
    expect(await screen.findByText('closing balance')).toBeTruthy();
    expect(screen.getByText('Differs')).toBeTruthy();
  });

  it('downloads the PDF as a binary file named after the invoice', async () => {
    const calls = mockApi(route);
    const files = captureDownloads();
    await renderPage(InvoicesPage);
    await screen.findAllByTestId('invoice-row');
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF of INV-2026-000002' }));
    await waitFor(() => {
      expect(files).toHaveLength(1);
    });
    expect(files[0]?.name).toBe('INV-2026-000002.pdf');
    expect(await files[0]?.blob.text()).toBe('%PDF-1.4 test');
    expect(calls.some((c) => c.path === '/orgs/org_p/billing/invoices/inv_1/pdf')).toBe(true);
  });

  it('issues a finished month on demand', async () => {
    const calls = mockApi(route);
    await renderPage(InvoicesPage);
    fireEvent.change(await screen.findByLabelText('Month to issue'), {
      target: { value: '2026-10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await screen.findByText('2026-10: 1 new invoices for 3 organizations.')).toBeTruthy();
    const run = calls.find((c) => c.path.endsWith('/generate'));
    expect(run).toMatchObject({ method: 'POST', query: { period: '2026-10' } });
  });
});
