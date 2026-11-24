/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { batchState } from '../../components/billing/model';
import { i18n, setupI18n } from '../../i18n';
import { resetSessionForTests } from '../../lib/session';
import GiftCodesPage from './gift-codes';
import { type Call, captureDownloads, mockApi, renderPage, stubMatchMedia } from './test-kit';

stubMatchMedia();

const batch = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'gift',
  amountUsd: '5.00000000',
  maxRedemptions: 1,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  codes: 10,
  redemptions: 2,
  creditedUsd: '10.00000000',
  ...extra,
});

function routes() {
  const revoked = new Set<string>();
  return (call: Call) => {
    const base = '/orgs/org_p/billing/gift-batches';
    if (call.path === base && call.method === 'GET')
      return {
        status: 200,
        body: [
          batch('gcb_1', 'Launch'),
          batch('gcb_2', 'Students'),
          batch('gcb_3', 'Old', { revokedAt: '2026-11-02T00:00:00.000Z' }),
        ].map((b) => (revoked.has(b.id) ? { ...b, revokedAt: '2026-11-24T00:00:00.000Z' } : b)),
      };
    if (call.path === base && call.method === 'POST')
      return {
        status: 201,
        body: {
          ...batch('gcb_new', String(call.body?.name), {
            amountUsd: `${String(call.body?.amountUsd)}.00000000`,
            codes: 3,
            redemptions: 0,
            creditedUsd: '0.00000000',
          }),
          codes: ['GIFT-AAAA-1111', 'GIFT-BBBB-2222', 'GIFT-CCCC-3333'],
        },
      };
    const revoke = /\/gift-batches\/(gcb_\d)\/revoke$/.exec(call.path);
    if (revoke?.[1]) {
      revoked.add(revoke[1]);
      return { status: 200, body: batch(revoke[1], 'x') };
    }
    if (call.path === `${base}/gcb_1/redemptions`)
      return {
        status: 200,
        body: [
          {
            id: 'gcr_1',
            codeHint: 'GIFT-AA',
            organizationId: 'org_a',
            organizationName: 'Acme',
            transactionId: 'txn_9',
            redeemedAt: '2026-11-03T10:00:00.000Z',
          },
        ],
      };
    return undefined;
  };
}

describe('billing gift codes (card 25.1)', () => {
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

  it('creates a batch, shows the codes once and downloads them as CSV', async () => {
    const calls = mockApi(routes());
    const files = captureDownloads();
    await renderPage(GiftCodesPage);
    const form = await screen.findByRole('form', { name: 'Create a batch of codes' });
    fireEvent.change(within(form).getByLabelText('Batch name'), { target: { value: 'Yalda' } });
    fireEvent.change(within(form).getByLabelText('Type'), { target: { value: 'recharge' } });
    fireEvent.change(within(form).getByLabelText('Amount per code (USD)'), {
      target: { value: '2' },
    });
    fireEvent.change(within(form).getByLabelText('Number of codes'), { target: { value: '3' } });
    fireEvent.change(within(form).getByLabelText('Uses per code'), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Expires (optional)'), {
      target: { value: '2026-12-21' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create codes' }));
    const created = await screen.findByTestId('created-codes');
    expect(within(created).getByText('GIFT-BBBB-2222')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path.startsWith('/orgs'))?.body).toEqual({
      name: 'Yalda',
      kind: 'recharge',
      amountUsd: '2',
      count: 3,
      maxRedemptions: 5,
      expiresAt: '2026-12-21T20:29:59.000Z',
    });
    fireEvent.click(within(created).getByRole('button', { name: 'Download codes (CSV)' }));
    expect(files[0]?.name).toBe('dirouter-gift-codes-gcb_new.csv');
    const csv = (await files[0]?.blob.text()) ?? '';
    const lines = csv.replace(/^\uFEFF/, '').split('\n');
    expect(lines[0]).toBe(
      '"code","batch_id","batch","kind","amount_usd","max_redemptions","expires_at"',
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('"GIFT-CCCC-3333","gcb_new","Yalda"');
  });

  it('revokes the selected batches together after a confirmation', async () => {
    const calls = mockApi(routes());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage(GiftCodesPage);
    await screen.findAllByTestId('batch-row');
    // The already revoked batch cannot be selected again.
    expect(screen.getByRole('checkbox', { name: 'Select Old' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all active batches' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke selected (2)' }));
    expect(confirm).toHaveBeenCalledWith('Revoke 2 batches? This cannot be undone.');
    expect(await screen.findByText('2 batches revoked.')).toBeTruthy();
    const posted = calls
      .filter((c) => c.method === 'POST' && c.path.startsWith('/orgs'))
      .map((c) => c.path);
    expect(posted).toEqual([
      '/orgs/org_p/billing/gift-batches/gcb_1/revoke',
      '/orgs/org_p/billing/gift-batches/gcb_2/revoke',
    ]);
    await waitFor(() => {
      expect(screen.getAllByText('Revoked')).toHaveLength(3);
    });
  });

  it('shows who redeemed a batch', async () => {
    mockApi(routes());
    await renderPage(GiftCodesPage);
    const rows = await screen.findAllByTestId('batch-row');
    fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Redemptions' }));
    const table = await screen.findByTestId('redemption-table');
    expect(within(table).getByText('Acme')).toBeTruthy();
    expect(within(table).getByText('GIFT-AA…')).toBeTruthy();
  });

  it('knows active, expired and revoked batches apart', () => {
    const b = batch('gcb_x', 'x') as Parameters<typeof batchState>[0];
    expect(batchState(b)).toBe('active');
    expect(batchState({ ...b, expiresAt: '2020-01-01T00:00:00.000Z' })).toBe('expired');
    expect(batchState({ ...b, revokedAt: '2026-01-01T00:00:00.000Z' })).toBe('revoked');
  });
});
