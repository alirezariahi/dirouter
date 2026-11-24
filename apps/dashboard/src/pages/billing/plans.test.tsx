/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { resetSessionForTests } from '../../lib/session';
import PlansPage from './plans';
import { type Call, mockApi, renderPage, stubMatchMedia } from './test-kit';

stubMatchMedia();

const PLAN = {
  id: 'pln_1',
  name: 'Starter',
  priceUsd: '10.00000000',
  includedUsd: '12.00000000',
  active: true,
};
const SUBSCRIPTION = {
  id: 'sub_1',
  organizationId: 'org_a',
  organizationName: 'Acme',
  organizationSlug: 'acme',
  plan: { id: 'pln_1', name: 'Starter', priceUsd: '10.00000000' },
  status: 'active',
  periodStart: '2026-11-01T00:00:00.000Z',
  periodEnd: '2026-12-01T00:00:00.000Z',
  includedUsd: '12.00000000',
  usedUsd: '2.50000000',
  remainingUsd: '9.50000000',
  cancelAtPeriodEnd: true,
};

const route = (call: Call) => {
  if (call.path === '/orgs/org_p/billing/plans' && call.method === 'GET')
    return { status: 200, body: [PLAN] };
  if (call.path === '/orgs/org_p/billing/plans' && call.method === 'POST')
    return { status: 201, body: { ...PLAN, id: 'pln_2' } };
  if (call.path === '/orgs/org_p/billing/plans/pln_1') return { status: 200, body: PLAN };
  if (call.path === '/orgs/org_p/billing/subscriptions')
    return { status: 200, body: [SUBSCRIPTION] };
  return undefined;
};

describe('billing plans and subscriptions (card 25.2)', () => {
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

  it('defines a plan, changes its price and stops offering it', async () => {
    const calls = mockApi(route);
    await renderPage(PlansPage);
    const form = await screen.findByRole('form', { name: 'New plan' });
    fireEvent.change(within(form).getByLabelText('Plan name'), { target: { value: 'Pro' } });
    fireEvent.change(within(form).getByLabelText('Monthly fee (USD)'), { target: { value: '49' } });
    fireEvent.change(within(form).getByLabelText('Included credit (USD)'), {
      target: { value: '60' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add plan' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        name: 'Pro',
        priceUsd: '49',
        includedUsd: '60',
      });
    });

    const row = within(screen.getByTestId('plan-row'));
    expect(row.getByLabelText<HTMLInputElement>('Monthly fee of Starter').value).toBe('10');
    fireEvent.change(row.getByLabelText('Monthly fee of Starter'), { target: { value: '12.5' } });
    fireEvent.click(row.getByRole('button', { name: 'Save Starter' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'PATCH')[0]?.body).toEqual({ priceUsd: '12.5' });
    });
    fireEvent.click(row.getByRole('checkbox', { name: 'Offer Starter' }));
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'PATCH')[1]?.body).toEqual({ active: false });
    });
  });

  it('lists every customer subscription with its allowance', async () => {
    mockApi(route);
    await renderPage(PlansPage);
    const row = within(await screen.findByTestId('subscription-row'));
    expect(row.getByText('Acme')).toBeTruthy();
    expect(row.getByText('Ends at period end')).toBeTruthy();
    const exact = [...row.getAllByTitle(/^USD /)].map((e) => e.getAttribute('data-exact'));
    expect(exact).toEqual(['10', '2.5', '12', '9.5']);
  });
});
