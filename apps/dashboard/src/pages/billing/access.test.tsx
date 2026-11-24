/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { billingAccess } from '../../lib/billing';
import { resetSessionForTests } from '../../lib/session';
import { makeRouter } from '../../router';
import { SettingsProvider } from '../../settings';
import { member, mockApi, stubMatchMedia } from './test-kit';

stubMatchMedia();
Object.defineProperty(globalThis, 'ResizeObserver', {
  writable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});

async function renderAt(path: string) {
  const router = makeRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsProvider>
        <RouterProvider router={router} />
      </SettingsProvider>
    </QueryClientProvider>,
  );
  await act(async () => {
    await router.load();
  });
}

const wallets = () => ({ status: 200, body: [] });

describe('billing is only for the platform organization with billing:read (card 25.1)', () => {
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

  it('the platform operator sees the menu entry and every billing tab', async () => {
    mockApi(wallets);
    await renderAt('/billing');
    const nav = screen.getByRole('navigation', { name: 'main' });
    expect(within(nav).getByRole('link', { name: 'Billing' })).toBeTruthy();
    const tabs = await screen.findByRole('navigation', { name: 'Billing' });
    for (const name of [
      'Customers and wallets',
      'Payments',
      'Gift codes',
      'Pricing',
      'Plans and subscriptions',
      'Invoices',
      'Profit report',
      'Gateways and rates',
    ])
      expect(within(tabs).getByRole('link', { name })).toBeTruthy();
    expect(await screen.findByText('There are no customer organizations yet.')).toBeTruthy();
  });

  it('a customer organization has no billing menu and the page says not found', async () => {
    const calls = mockApi(wallets, member({ isPlatform: false }));
    await renderAt('/billing');
    const nav = screen.getByRole('navigation', { name: 'main' });
    expect(within(nav).queryByRole('link', { name: 'Billing' })).toBeNull();
    expect(await screen.findByTestId('billing-gate')).toBeTruthy();
    expect(calls.some((c) => c.path.includes('/billing/'))).toBe(false);
  });

  it('a platform member without billing:read does not see it either', async () => {
    mockApi(wallets, member({ role: 'MEMBER', permissions: ['keys:read', 'keys:write'] }));
    await renderAt('/billing/payments');
    const nav = screen.getByRole('navigation', { name: 'main' });
    expect(within(nav).queryByRole('link', { name: 'Billing' })).toBeNull();
    expect(await screen.findByTestId('billing-gate')).toBeTruthy();
  });

  it('reads the permission list the API sends', () => {
    const platform = { role: 'VIEWER' as const, isPlatform: true };
    expect(billingAccess({ ...platform, permissions: ['billing:read'] })).toEqual({
      visible: true,
      write: false,
    });
    expect(billingAccess({ ...platform, permissions: ['billing:read', 'billing:write'] })).toEqual({
      visible: true,
      write: true,
    });
    expect(
      billingAccess({ role: 'OWNER', isPlatform: false, permissions: ['billing:read'] }),
    ).toEqual({ visible: false, write: false });
    expect(billingAccess(undefined)).toEqual({ visible: false, write: false });
  });
});
