/**
 * Invoices (card 25.2): every customer's monthly invoice, filtered by month, with the PDF and a
 * check that recomputes a stored invoice from the ledger and compares every figure. The monthly
 * run (also scheduled in the worker) can be started by hand for a finished month; it is
 * idempotent, an issued invoice never changes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClass,
  DataTable,
  inputClass,
  Money,
  Notice,
  numClass,
  rowClass,
  Status,
} from '../../components/billing/common';
import { useCustomers } from '../../components/billing/model';
import { Section } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { useBillingAccess } from '../../lib/billing';
import { downloadBlob } from '../../lib/csv';
import { errorMessage } from '../../lib/errors';
import { useFormat } from '../../lib/s2-format';

interface Invoice {
  id: string;
  number: string;
  organizationId: string;
  period: string;
  basis: 'prepaid' | 'postpaid';
  openingUsd: string;
  closingUsd: string;
  totals: Record<string, string>;
  lines: { model: string; requests: number; amountUsd: string }[];
  createdAt: string;
}
interface Verification {
  ok: boolean;
  problems: string[];
}

/** The last finished month, `YYYY-MM` (UTC), the newest one the monthly run accepts. */
function lastMonth(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
}

export default function InvoicesPage() {
  const { t } = useTranslation();
  const { n } = useFormat();
  const qc = useQueryClient();
  const { orgId, write } = useBillingAccess();
  const base = `/orgs/${orgId}/billing/invoices`;
  const [period, setPeriod] = useState('');
  const [runPeriod, setRunPeriod] = useState(lastMonth);
  const [checks, setChecks] = useState<Record<string, Verification>>({});
  const customers = useCustomers(orgId);
  const invoices = useQuery({
    queryKey: ['billing', orgId, 'invoices', period],
    queryFn: () => api<Invoice[]>(base, { query: { period: period || undefined } }),
    enabled: Boolean(orgId),
  });
  const generate = useMutation({
    mutationFn: () =>
      api<{ period: string; organizations: number; created: number }>(`${base}/generate`, {
        method: 'POST',
        query: { period: runPeriod },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing', orgId, 'invoices'] }),
  });
  const verify = useMutation({
    mutationFn: (id: string) => api<Verification>(`${base}/${id}/verify`),
    onSuccess: (result, id) => {
      setChecks((current) => ({ ...current, [id]: result }));
    },
  });
  const pdf = useMutation({
    mutationFn: async (invoice: Invoice) => {
      const blob = await api<Blob>(`${base}/${invoice.id}/pdf`, { responseType: 'blob' });
      downloadBlob(`${invoice.number}.pdf`, blob);
    },
  });

  const nameOf = new Map(customers.data?.map((c) => [c.organizationId, c.name]));
  const rows = invoices.data ?? [];
  const failure = verify.error ?? pdf.error;

  return (
    <div className="flex flex-col gap-6">
      <Section
        title={t('billing.invoices.title')}
        help={t('billing.invoices.help')}
        action={
          <label className="flex items-center gap-2 text-[13px] text-fg-2">
            {t('billing.invoices.month')}
            <input
              type="month"
              dir="ltr"
              className={`${inputClass} h-9`}
              value={period}
              onChange={(e) => {
                setPeriod(e.target.value);
              }}
            />
          </label>
        }
      >
        <FormError message={failure ? errorMessage(failure, t) : undefined} />
        {invoices.isError ? (
          <ErrorState error={invoices.error} onRetry={() => void invoices.refetch()} />
        ) : invoices.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.invoices.none')}</p>
        ) : (
          <DataTable
            testId="invoice-table"
            minWidth={980}
            caption={t('billing.invoices.title')}
            columns={[
              { key: 'number', label: t('billing.invoices.col.number') },
              { key: 'customer', label: t('billing.invoices.col.customer') },
              { key: 'basis', label: t('billing.invoices.col.basis') },
              { key: 'opening', label: t('billing.invoices.col.opening'), numeric: true },
              { key: 'usage', label: t('billing.invoices.col.usage'), numeric: true },
              { key: 'closing', label: t('billing.invoices.col.closing'), numeric: true },
              { key: 'check', label: t('billing.invoices.col.check') },
              { key: 'actions', label: t('billing.common.actions'), numeric: true },
            ]}
          >
            {rows.map((inv) => {
              const check = checks[inv.id];
              return (
                <tr key={inv.id} className={rowClass} data-testid="invoice-row">
                  <td className={cellClass}>
                    <code dir="ltr" className="text-[13px] font-medium">
                      {inv.number}
                    </code>
                    <p className="text-xs text-muted" dir="ltr">
                      {inv.period}
                    </p>
                  </td>
                  <td className={cellClass}>
                    {nameOf.get(inv.organizationId) ?? (
                      <code dir="ltr" className="text-xs">
                        {inv.organizationId}
                      </code>
                    )}
                  </td>
                  <td className={cellClass}>{t(`billing.invoices.basis.${inv.basis}`)}</td>
                  <td className={numClass}>
                    <Money value={inv.openingUsd} />
                  </td>
                  <td className={numClass}>
                    {inv.totals.usage ? <Money value={inv.totals.usage} /> : '—'}
                    <p className="text-xs text-muted">
                      {t('billing.invoices.lines', { n: n(inv.lines.length) })}
                    </p>
                  </td>
                  <td className={numClass}>
                    <Money value={inv.closingUsd} />
                  </td>
                  <td className={cellClass} data-testid="invoice-check">
                    {check ? (
                      check.ok ? (
                        <Status tone="good" label={t('billing.invoices.matches')} />
                      ) : (
                        <>
                          <Status tone="danger" label={t('billing.invoices.differs')} />
                          <p className="mt-1 text-xs text-danger">{check.problems.join(', ')}</p>
                        </>
                      )
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-end">
                    <span className="inline-flex gap-2">
                      <Button
                        variant="outline"
                        aria-label={t('billing.invoices.verifyOf', { number: inv.number })}
                        disabled={verify.isPending}
                        onClick={() => {
                          verify.mutate(inv.id);
                        }}
                      >
                        {t('billing.invoices.verify')}
                      </Button>
                      <Button
                        variant="outline"
                        aria-label={t('billing.invoices.pdfOf', { number: inv.number })}
                        disabled={pdf.isPending}
                        onClick={() => {
                          pdf.mutate(inv);
                        }}
                      >
                        PDF
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Section>

      <Section title={t('billing.invoices.run')} help={t('billing.invoices.runHelp')}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-[13px] font-medium text-fg-2">{t('billing.invoices.month')}</span>
            <input
              type="month"
              dir="ltr"
              aria-label={t('billing.invoices.runMonth')}
              className={inputClass}
              max={lastMonth()}
              value={runPeriod}
              onChange={(e) => {
                setRunPeriod(e.target.value);
              }}
            />
          </label>
          <Button
            disabled={!write || !runPeriod || generate.isPending}
            onClick={() => {
              generate.mutate();
            }}
          >
            {t('billing.invoices.generate')}
          </Button>
        </div>
        <FormError message={generate.error ? errorMessage(generate.error, t) : undefined} />
        {generate.data ? (
          <Notice tone="good">
            {t('billing.invoices.generated', {
              period: generate.data.period,
              created: n(generate.data.created),
              organizations: n(generate.data.organizations),
            })}
          </Notice>
        ) : null}
      </Section>
    </div>
  );
}
