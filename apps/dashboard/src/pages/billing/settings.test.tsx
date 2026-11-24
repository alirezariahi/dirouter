/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsBody } from '../../components/billing/model';
import { i18n, setupI18n } from '../../i18n';
import { resetSessionForTests } from '../../lib/session';
import BillingSettingsPage from './settings';
import { type Call, mockApi, renderPage, stubMatchMedia } from './test-kit';

stubMatchMedia();

const SETTINGS = {
  exchangeRates: {} as Record<string, string>,
  topup: { minUsd: '1', maxUsd: '1000' },
  providers: ['stripe'],
  portal: { signupEnabled: false, welcomeCreditUsd: '0' },
  available: ['stripe'],
};

const route = (call: Call) => {
  if (call.path !== '/orgs/org_p/billing/settings') return undefined;
  if (call.method === 'PUT') {
    const body = call.body as typeof SETTINGS;
    return {
      status: 200,
      body: {
        ...body,
        available: body.providers.filter((p) => p !== 'zarinpal' || body.exchangeRates.IRR),
      },
    };
  }
  return { status: 200, body: SETTINGS };
};

describe('billing gateway settings (card 25.1)', () => {
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

  it('shows which gateways are really offered', async () => {
    mockApi(route);
    await renderPage(BillingSettingsPage);
    expect(
      within(await screen.findByTestId('gateway-stripe')).getByText('On and ready'),
    ).toBeTruthy();
    expect(within(screen.getByTestId('gateway-zarinpal')).getByText('Off')).toBeTruthy();
  });

  it('will not turn on Zarinpal without an IRR rate, then saves rate, limits and portal', async () => {
    const calls = mockApi(route);
    await renderPage(BillingSettingsPage);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Zarinpal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByText('Zarinpal does not work without an IRR rate.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add a rate' }));
    expect(screen.getByLabelText<HTMLInputElement>('Currency of row 1').value).toBe('IRR');
    fireEvent.change(screen.getByLabelText('IRR rate'), { target: { value: '1050000' } });
    fireEvent.change(screen.getByLabelText('Largest top-up (USD)'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Anyone may sign up on the portal' }));
    fireEvent.change(screen.getByLabelText('Welcome credit (USD)'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Saved; it applies from now on.');
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      exchangeRates: { IRR: '1050000' },
      topup: { minUsd: '1', maxUsd: '500' },
      providers: ['stripe', 'zarinpal'],
      portal: { signupEnabled: true, welcomeCreditUsd: '0.5' },
    });
    await waitFor(() => {
      expect(within(screen.getByTestId('gateway-zarinpal')).getByText('On and ready')).toBeTruthy();
    });
  });

  it('checks the draft the way the API will', () => {
    const draft = {
      providers: [] as ('zarinpal' | 'stripe')[],
      rates: [{ currency: 'eur', rate: '0.9' }],
      minUsd: '1',
      maxUsd: '10',
      signupEnabled: false,
      welcomeCreditUsd: '0',
    };
    expect(settingsBody(draft)).toMatchObject({ body: { exchangeRates: { EUR: '0.9' } } });
    expect(settingsBody({ ...draft, rates: [{ currency: 'EURO', rate: '1' }] })).toEqual({
      problem: 'currency',
    });
    expect(settingsBody({ ...draft, rates: [{ currency: 'EUR', rate: '0' }] })).toEqual({
      problem: 'rate',
    });
    expect(settingsBody({ ...draft, minUsd: '20' })).toEqual({ problem: 'limits' });
    expect(settingsBody({ ...draft, maxUsd: '-1' })).toEqual({ problem: 'amount' });
  });
});
