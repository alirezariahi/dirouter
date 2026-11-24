/**
 * Payments (card 25.1): every top-up through Zarinpal or Stripe, filtered by status, and the
 * reconcile run that asks the provider about payments still pending after two minutes (a lost
 * callback or webhook). A settled payment credits the wallet exactly once, whoever settles it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClass,
  DataTable,
  Money,
  Notice,
  numClass,
  rowClass,
  Status,
} from '../../components/billing/common';
import { useCustomers } from '../../components/billing/model';
import { Section, Segmented } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { useBillingAccess } from '../../lib/billing';
import { downloadCsv } from '../../lib/csv';
import { formatDate } from '../../lib/date';
import { errorMessage } from '../../lib/errors';
import { useFormat } from '../../lib/s2-format';

const STATUSES = ['all', 'pending', 'succeeded', 'failed', 'expired'] as const;
type Filter = (typeof STATUSES)[number];

interface Payment {
  id: string;
  organizationId: string;
  provider: 'zarinpal' | 'stripe';
  status: 'pending' | 'succeeded' | 'failed' | 'expired';
  amountUsd: string;
  currency: string;
  amountMinor: string;
  exchangeRate: string;
  providerTxId: string | null;
  failureReason: string | null;
  transactionId: string | null;
  createdAt: string;
  completedAt: string | null;
}
type Reconciled = { checked: number; skipped?: boolean } & Record<string, number | boolean>;

const TONE = { pending: 'warn', succeeded: 'good', failed: 'danger', expired: 'muted' } as const;
/** Minor units per major unit of the currencies the providers charge in. */
const MINOR: Record<string, number> = { IRR: 1, USD: 100 };

export default function PaymentsPage() {
  const { t } = useTranslation();
  const { n, settings } = useFormat();
  const qc = useQueryClient();
  const { orgId, write } = useBillingAccess();
  const [filter, setFilter] = useState<Filter>('all');
  const customers = useCustomers(orgId);
  const payments = useQuery({
    queryKey: ['billing', orgId, 'payments', filter],
    queryFn: () =>
      api<Payment[]>(`/orgs/${orgId}/billing/payments`, {
        query: { limit: 500, status: filter === 'all' ? undefined : filter },
      }),
    enabled: Boolean(orgId),
  });
  const reconcile = useMutation({
    mutationFn: () =>
      api<Reconciled>(`/orgs/${orgId}/billing/payments/reconcile`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing', orgId] }),
  });

  const nameOf = new Map(customers.data?.map((c) => [c.organizationId, c.name]));
  const date = (value: string) =>
    formatDate(value, { calendar: settings.calendar, lang: settings.lang, time: true });
  const local = (p: Payment) =>
    n(Number(p.amountMinor) / (MINOR[p.currency] ?? 100), {
      style: 'currency',
      currency: p.currency,
      maximumFractionDigits: p.currency === 'IRR' ? 0 : 2,
    });
  const rows = payments.data ?? [];
  const outcome = reconcile.data;

  return (
    <div className="flex flex-col gap-6">
      <Section
        title={t('billing.payments.title')}
        help={t('billing.payments.help')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={rows.length === 0}
              onClick={() => {
                downloadCsv(
                  'dirouter-payments.csv',
                  [
                    'id',
                    'organization_id',
                    'organization',
                    'provider',
                    'status',
                    'amount_usd',
                    'currency',
                    'amount_minor',
                    'exchange_rate',
                    'provider_tx_id',
                    'created_at',
                    'completed_at',
                  ],
                  rows.map((p) => [
                    p.id,
                    p.organizationId,
                    nameOf.get(p.organizationId) ?? '',
                    p.provider,
                    p.status,
                    p.amountUsd,
                    p.currency,
                    p.amountMinor,
                    p.exchangeRate,
                    p.providerTxId ?? '',
                    p.createdAt,
                    p.completedAt ?? '',
                  ]),
                );
              }}
            >
              {t('billing.common.exportCsv')}
            </Button>
            <Button
              disabled={!write || reconcile.isPending}
              onClick={() => {
                reconcile.mutate();
              }}
            >
              {t('billing.payments.reconcile')}
            </Button>
          </div>
        }
      >
        <Segmented
          ariaLabel={t('billing.payments.filter')}
          value={filter}
          onChange={setFilter}
          size="sm"
          options={STATUSES.map((s) => ({ value: s, label: t(`billing.payments.status.${s}`) }))}
        />
        <FormError message={reconcile.isError ? errorMessage(reconcile.error, t) : undefined} />
        {outcome ? (
          <Notice tone="good">
            <span data-testid="reconcile-result">
              {t('billing.payments.reconciled', { n: n(outcome.checked) })}
              {Object.entries(outcome)
                .filter(([k, v]) => k !== 'checked' && k !== 'skipped' && typeof v === 'number')
                .map(
                  ([k, v]) =>
                    ` · ${t(`billing.payments.status.${k}`, { defaultValue: k })}: ${n(Number(v))}`,
                )
                .join('')}
            </span>
          </Notice>
        ) : null}
        {payments.isError ? (
          <ErrorState error={payments.error} onRetry={() => void payments.refetch()} />
        ) : payments.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.payments.none')}</p>
        ) : (
          <DataTable
            testId="payment-table"
            minWidth={960}
            caption={t('billing.payments.title')}
            columns={[
              { key: 'when', label: t('billing.payments.col.when') },
              { key: 'customer', label: t('billing.payments.col.customer') },
              { key: 'provider', label: t('billing.payments.col.provider') },
              { key: 'status', label: t('billing.payments.col.status') },
              { key: 'amount', label: t('billing.payments.col.amount'), numeric: true },
              { key: 'charged', label: t('billing.payments.col.charged'), numeric: true },
              { key: 'reference', label: t('billing.payments.col.reference') },
            ]}
          >
            {rows.map((p) => (
              <tr key={p.id} className={rowClass} data-testid="payment-row">
                <td className={`${cellClass} whitespace-nowrap`}>
                  {date(p.createdAt)}
                  {p.completedAt ? (
                    <p className="text-xs text-muted">
                      {t('billing.payments.completed')}: {date(p.completedAt)}
                    </p>
                  ) : null}
                </td>
                <td className={cellClass}>
                  {nameOf.get(p.organizationId) ?? (
                    <code dir="ltr" className="text-xs">
                      {p.organizationId}
                    </code>
                  )}
                </td>
                <td className={cellClass}>{t(`billing.provider.${p.provider}`)}</td>
                <td className={cellClass}>
                  <Status tone={TONE[p.status]} label={t(`billing.payments.status.${p.status}`)} />
                  {p.failureReason ? (
                    <p className="mt-1 text-xs text-muted">{p.failureReason}</p>
                  ) : null}
                </td>
                <td className={numClass}>
                  <Money value={p.amountUsd} />
                </td>
                <td className={numClass}>
                  <bdi>{local(p)}</bdi>
                </td>
                <td className={cellClass}>
                  <code dir="ltr" className="block truncate text-xs text-muted">
                    {p.providerTxId ?? p.id}
                  </code>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>
    </div>
  );
}
