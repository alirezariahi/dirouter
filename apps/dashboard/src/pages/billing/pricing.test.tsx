/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n, setupI18n } from '../../i18n';
import { multiplyUsd } from '../../lib/billing';
import { resetSessionForTests } from '../../lib/session';
import PricingPage from './pricing';
import { ALL_BILLING, type Call, member, mockApi, renderPage, stubMatchMedia } from './test-kit';

stubMatchMedia();

const MODEL = {
  id: 'mdl_1',
  slug: 'mock/small',
  displayName: null,
  enabled: true,
  pricing: { inputPerMTok: '2', outputPerMTok: '8' },
  isPublic: false,
  sale: { multiplier: '1', perRequestUsd: null, cacheMultiplier: '0' },
};

function routes() {
  const state = { model: { ...MODEL }, groups: [] as Record<string, unknown>[] };
  return (call: Call) => {
    const p = call.path;
    if (p === '/orgs/org_p/models') return { status: 200, body: [state.model] };
    if (p === '/orgs/org_p/models/mdl_1' && call.method === 'PATCH') {
      const body = call.body as { isPublic: boolean; sale: typeof MODEL.sale };
      state.model = { ...state.model, isPublic: body.isPublic, sale: { ...body.sale } };
      return { status: 200, body: state.model };
    }
    if (p === '/orgs/org_p/billing/groups' && call.method === 'GET')
      return { status: 200, body: state.groups };
    if (p === '/orgs/org_p/billing/groups' && call.method === 'POST') {
      state.groups.push({
        id: 'cgr_1',
        name: call.body?.name,
        multiplier: `${String(call.body?.multiplier)}0000000`,
        description: null,
        organizations: 0,
      });
      return { status: 201, body: state.groups[0] };
    }
    if (p === '/orgs/org_p/billing/groups/cgr_1' && call.method === 'PATCH') {
      state.groups = state.groups.map((g) => ({ ...g, multiplier: call.body?.multiplier }));
      return { status: 200, body: state.groups[0] };
    }
    if (p === '/orgs/org_p/billing/groups/cgr_1' && call.method === 'DELETE') {
      state.groups = [];
      return { status: 204 };
    }
    if (p === '/orgs/org_p/billing/wallets')
      return {
        status: 200,
        body: [
          {
            organizationId: 'org_a',
            name: 'Acme',
            slug: 'acme',
            prepaid: true,
            walletId: 'w',
            balanceUsd: '1.00000000',
            customerGroupId: null,
          },
        ],
      };
    if (p === '/orgs/org_p/billing/wallets/org_a/group')
      return { status: 200, body: { organizationId: 'org_a', ...call.body } };
    return undefined;
  };
}

describe('billing pricing (card 25.2)', () => {
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

  it('a new multiplier and publishing are saved on the model for the next request', async () => {
    const calls = mockApi(routes());
    await renderPage(PricingPage);
    const row = (await screen.findAllByTestId('model-price-row'))[0] as HTMLElement;
    const r = within(row);
    expect(r.getByTestId('sale-price').textContent).toBe('2 / 8');
    fireEvent.change(r.getByLabelText('Multiplier of mock/small'), { target: { value: '1.5' } });
    // The preview is the gateway's own arithmetic (cost × multiplier, 8 decimals).
    expect(r.getByTestId('sale-price').textContent).toBe('3 / 12');
    fireEvent.click(r.getByRole('checkbox', { name: 'Publish mock/small in the marketplace' }));
    fireEvent.click(r.getByRole('button', { name: 'Save price of mock/small' }));
    expect(await r.findByText('Saved; applies from the next request.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/orgs/org_p/models/mdl_1',
      query: {},
      body: {
        isPublic: true,
        sale: { multiplier: '1.5', perRequestUsd: null, cacheMultiplier: '0' },
      },
    });
    expect(r.getByText('Published')).toBeTruthy();
  });

  it('a fixed price per request replaces the token price; a bad multiplier is refused locally', async () => {
    const calls = mockApi(routes());
    await renderPage(PricingPage);
    const row = within((await screen.findAllByTestId('model-price-row'))[0] as HTMLElement);
    fireEvent.change(row.getByLabelText('Fixed price of mock/small'), {
      target: { value: '0.04' },
    });
    expect(row.getByTestId('sale-price').textContent).toContain('per request');
    fireEvent.change(row.getByLabelText('Multiplier of mock/small'), { target: { value: '-1' } });
    fireEvent.click(row.getByRole('button', { name: 'Save price of mock/small' }));
    expect(
      row.getByText('The multiplier is a non-negative number with at most 8 decimals.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('creates, changes and deletes a customer group and assigns customers to it', async () => {
    const calls = mockApi(routes());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage(PricingPage);
    const form = await screen.findByRole('form', { name: 'New group' });
    fireEvent.change(within(form).getByLabelText('Group name'), { target: { value: 'Resellers' } });
    fireEvent.change(within(form).getByLabelText('Multiplier'), { target: { value: '0.8' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add group' }));
    const row = await screen.findByTestId('group-row');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Resellers',
      multiplier: '0.8',
    });

    fireEvent.change(within(row).getByLabelText('Multiplier of group Resellers'), {
      target: { value: '0.75' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ multiplier: '0.75' });
    });

    const select = await screen.findByLabelText('Group of Acme');
    await within(select).findByRole('option', { name: /Resellers/ });
    fireEvent.change(select, { target: { value: 'cgr_1' } });
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ customerGroupId: 'cgr_1' });
    });

    fireEvent.click(
      within(screen.getByTestId('group-row')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(
        '/orgs/org_p/billing/groups/cgr_1',
      );
    });
  });

  it('model prices stay read-only without models:write', async () => {
    mockApi(routes(), member({ role: 'MEMBER', permissions: ALL_BILLING }));
    await renderPage(PricingPage);
    const row = within((await screen.findAllByTestId('model-price-row'))[0] as HTMLElement);
    expect(row.getByLabelText('Multiplier of mock/small').matches(':disabled')).toBe(true);
    expect(screen.getByText('Saving a model price also needs models:write.')).toBeTruthy();
  });

  it('multiplies like the gateway: half up at 8 decimals', () => {
    expect(multiplyUsd('0.00000003', '0.5')).toBe('0.00000002');
    expect(multiplyUsd('2', '1.3')).toBe('2.60000000');
    expect(multiplyUsd('1.23456789', '3')).toBe('3.70370367');
  });
});
