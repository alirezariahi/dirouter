/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { trimUsd } from '../../lib/billing';
import { resetSessionForTests } from '../../lib/session';
import ProfitPage from './profit';
import { type Call, captureDownloads, mockApi, renderPage, stubMatchMedia } from './test-kit';

stubMatchMedia();

/** What reports/profit answers; deliberately with figures that round differently at 2 decimals. */
const REPORT = {
  from: '2026-11-01',
  to: '2026-11-25',
  filters: { organizationId: null, model: null },
  models: [
    {
      model: 'shop/smart',
      providerId: 'prv_a',
      requests: 10,
      costUsd: '4.00012345',
      revenueUsd: '5.00098765',
      profitUsd: '1.00086420',
      marginPercent: 20.01,
    },
    {
      model: 'shop/fast',
      providerId: 'prv_a',
      requests: 40,
      costUsd: '2.00000001',
      revenueUsd: '1.99999999',
      profitUsd: '-0.00000002',
      marginPercent: -0,
    },
  ],
  totals: { costUsd: '6.00012346', revenueUsd: '7.00098764', profitUsd: '1.00086418' },
  ledger: {
    revenueBookedUsd: '6.37500000',
    writtenOffUsd: '0.00000000',
    promoGivenUsd: '5.00000000',
    fundsReceivedUsd: '24.00000000',
  },
};

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
  if (call.path === '/orgs/org_p/billing/reports/profit') {
    const models = REPORT.models.filter((m) => !call.query.model || m.model === call.query.model);
    return {
      status: 200,
      body: {
        ...REPORT,
        from: call.query.from,
        to: call.query.to,
        models,
        ...(call.query.model
          ? {
              totals: models[0] && {
                costUsd: models[0].costUsd,
                revenueUsd: models[0].revenueUsd,
                profitUsd: models[0].profitUsd,
              },
            }
          : {}),
      },
    };
  }
  return undefined;
};

const exact = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-exact]')].map((e) => e.getAttribute('data-exact'));

describe('billing profit report (card 25.2)', () => {
  beforeEach(async () => {
    resetSessionForTests();
    setupI18n('en');
    await i18n.changeLanguage('en');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows exactly the figures reports/profit returns, for this month by default', async () => {
    const calls = mockApi(route);
    await renderPage(ProfitPage);
    const totals = await screen.findByTestId('profit-totals');
    // Each total is the endpoint's own string, not a browser re-addition of the rows.
    expect(exact(totals)).toEqual([
      trimUsd(REPORT.totals.revenueUsd),
      trimUsd(REPORT.totals.costUsd),
      trimUsd(REPORT.totals.profitUsd),
    ]);
    expect(within(totals).getByText('7.00098764')).toBeTruthy();
    const rows = screen.getAllByTestId('profit-row');
    expect(rows.map((r) => exact(r))).toEqual(
      REPORT.models.map((m) => [m.costUsd, m.revenueUsd, m.profitUsd].map(trimUsd)),
    );
    expect(within(rows[0] as HTMLElement).getByText('20.01%')).toBeTruthy();
    expect(exact(screen.getByTestId('profit-ledger'))).toEqual(['6.375', '24', '5', '0']);
    // [1 Nov, 25 Nov): "until 24 Nov" inclusive is sent as the exclusive next day.
    const sent = calls.find((c) => c.path.endsWith('/reports/profit'));
    expect(sent?.query).toEqual({ from: '2026-11-01', to: '2026-11-25' });
  });

  it('sends the range, customer and model filters to the endpoint', async () => {
    const calls = mockApi(route);
    await renderPage(ProfitPage);
    await screen.findByTestId('profit-totals');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Until (inclusive)'), {
      target: { value: '2026-10-31' },
    });
    const customer = screen.getByLabelText('Customer');
    await within(customer).findByRole('option', { name: 'Acme' });
    fireEvent.change(customer, { target: { value: 'org_a' } });
    const model = screen.getByLabelText('Model');
    await within(model).findByRole('option', { name: 'shop/fast' });
    fireEvent.change(model, { target: { value: 'shop/fast' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('profit-row')).toHaveLength(1);
    });
    const last = calls.filter((c) => c.path.endsWith('/reports/profit')).at(-1);
    expect(last?.query).toEqual({
      from: '2026-10-01',
      to: '2026-11-01',
      organizationId: 'org_a',
      model: 'shop/fast',
    });
    expect(exact(screen.getByTestId('profit-totals'))).toEqual([
      '1.99999999',
      '2.00000001',
      '-0.00000002',
    ]);
  });

  it('exports the report with the endpoint’s exact strings', async () => {
    mockApi(route);
    const files = captureDownloads();
    await renderPage(ProfitPage);
    await screen.findByTestId('profit-totals');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(files[0]?.name).toBe('dirouter-profit-2026-11-01_2026-11-24.csv');
    const lines = ((await files[0]?.blob.text()) ?? '').replace(/^\uFEFF/, '').split('\n');
    expect(lines).toEqual([
      '"model","provider_id","requests","cost_usd","revenue_usd","profit_usd","margin_percent"',
      '"shop/smart","prv_a","10","4.00012345","5.00098765","1.00086420","20.01"',
      '"shop/fast","prv_a","40","2.00000001","1.99999999","-0.00000002","0"',
      '"TOTAL","","50","6.00012346","7.00098764","1.00086418",""',
    ]);
  });

  it('refuses a range that ends before it starts', async () => {
    mockApi(route);
    await renderPage(ProfitPage);
    await screen.findByTestId('profit-totals');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-12-01' } });
    expect(screen.getByText('The start date must not be after the end date.')).toBeTruthy();
  });
});
