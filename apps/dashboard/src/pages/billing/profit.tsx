/**
 * Profit report (card 25.2): what the platform paid providers against what customers were charged,
 * by model, for a range of whole UTC days, optionally for one customer and/or one model. Every
 * figure on the page is the `reports/profit` answer itself, shown as sent (never re-added in the
 * browser), so the page and the endpoint always agree; the CSV carries the same exact strings.
 * The ledger figures are the platform's system accounts and do not narrow with the filters.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BarList } from '../../components/charts/bar-list';
import {
  cellClass,
  DataTable,
  inputClass,
  Money,
  numClass,
  rowClass,
} from '../../components/billing/common';
import { useCustomers } from '../../components/billing/model';
import { Section, selectClass } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { isoDay, nextDay, trimUsd, useBillingAccess } from '../../lib/billing';
import { downloadCsv } from '../../lib/csv';
import { useFormat } from '../../lib/s2-format';

interface ProfitReport {
  from: string;
  to: string;
  filters?: { organizationId: string | null; model: string | null };
  models: {
    model: string;
    providerId: string;
    requests: number;
    costUsd: string;
    revenueUsd: string;
    profitUsd: string;
    marginPercent: number | null;
  }[];
  totals: { costUsd: string; revenueUsd: string; profitUsd: string };
  ledger: {
    revenueBookedUsd: string;
    writtenOffUsd: string;
    promoGivenUsd: string;
    fundsReceivedUsd: string;
  };
}

const monthStart = (now: Date) =>
  isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

export default function ProfitPage() {
  const { t } = useTranslation();
  const { n } = useFormat();
  const { orgId } = useBillingAccess();
  const today = isoDay(new Date());
  const [from, setFrom] = useState(() => monthStart(new Date()));
  /** Shown inclusive; the API's `to` is exclusive, so the request asks for the next day. */
  const [until, setUntil] = useState(today);
  const [customer, setCustomer] = useState('');
  const [model, setModel] = useState('');
  const customers = useCustomers(orgId);
  const valid = Boolean(from && until && from <= until);
  const query = {
    from,
    to: valid ? nextDay(until) : until,
    organizationId: customer || undefined,
    model: model || undefined,
  };
  const report = useQuery({
    queryKey: ['billing', orgId, 'profit', query],
    queryFn: () => api<ProfitReport>(`/orgs/${orgId}/billing/reports/profit`, { query }),
    enabled: Boolean(orgId) && valid,
    placeholderData: keepPreviousData,
  });
  // The model filter offers what the range sold, for the chosen customer (unfiltered by model).
  const models = useQuery({
    queryKey: ['billing', orgId, 'profit-models', query.from, query.to, customer],
    queryFn: () =>
      api<ProfitReport>(`/orgs/${orgId}/billing/reports/profit`, {
        query: { from: query.from, to: query.to, organizationId: customer || undefined },
      }),
    enabled: Boolean(orgId) && valid,
  });
  const modelOptions = [
    ...new Set([...(models.data?.models ?? []).map((m) => m.model), ...(model ? [model] : [])]),
  ];
  const data = report.data;
  const margin =
    data && Number(data.totals.revenueUsd) > 0
      ? Number(data.totals.profitUsd) / Number(data.totals.revenueUsd)
      : undefined;

  const exportCsv = (r: ProfitReport) => {
    const name = customers.data?.find((c) => c.organizationId === customer)?.slug;
    downloadCsv(
      `dirouter-profit-${r.from}_${until}${name ? `-${name}` : ''}${model ? `-${model.replaceAll('/', '_')}` : ''}.csv`,
      [
        'model',
        'provider_id',
        'requests',
        'cost_usd',
        'revenue_usd',
        'profit_usd',
        'margin_percent',
      ],
      [
        ...r.models.map((m) => [
          m.model,
          m.providerId,
          m.requests,
          m.costUsd,
          m.revenueUsd,
          m.profitUsd,
          m.marginPercent ?? '',
        ]),
        [
          'TOTAL',
          '',
          r.models.reduce((s, m) => s + m.requests, 0),
          r.totals.costUsd,
          r.totals.revenueUsd,
          r.totals.profitUsd,
          '',
        ],
      ],
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-medium text-fg-2">{t('billing.profit.from')}</span>
          <input
            type="date"
            dir="ltr"
            className={inputClass}
            value={from}
            max={until}
            onChange={(e) => {
              setFrom(e.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-medium text-fg-2">{t('billing.profit.until')}</span>
          <input
            type="date"
            dir="ltr"
            className={inputClass}
            value={until}
            min={from}
            onChange={(e) => {
              setUntil(e.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-medium text-fg-2">{t('billing.profit.customer')}</span>
          <select
            className={selectClass}
            value={customer}
            onChange={(e) => {
              setCustomer(e.target.value);
            }}
          >
            <option value="">{t('billing.profit.allCustomers')}</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.organizationId} value={c.organizationId}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-[13px] font-medium text-fg-2">{t('billing.profit.model')}</span>
          <select
            className={selectClass}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
            }}
          >
            <option value="">{t('billing.profit.allModels')}</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          className="ms-auto"
          disabled={!data}
          onClick={() => {
            if (data) exportCsv(data);
          }}
        >
          {t('billing.common.exportCsv')}
        </Button>
      </Card>
      <FormError message={valid ? undefined : t('billing.profit.badRange')} />

      {report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !data ? (
        valid ? (
          <Loading />
        ) : null
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4" data-testid="profit-totals">
            <Total
              label={t('billing.profit.revenue')}
              value={data.totals.revenueUsd}
              testId="total-revenue"
            />
            <Total
              label={t('billing.profit.cost')}
              value={data.totals.costUsd}
              testId="total-cost"
            />
            <Total
              label={t('billing.profit.profit')}
              value={data.totals.profitUsd}
              testId="total-profit"
            />
            <Card className="flex flex-col gap-2">
              <span className="text-[13px] text-fg-2">{t('billing.profit.margin')}</span>
              <span className="num text-2xl leading-none font-medium">
                {margin === undefined
                  ? '—'
                  : n(margin, { style: 'percent', maximumFractionDigits: 2 })}
              </span>
              <span className="text-xs text-muted">
                {t('billing.profit.requests', {
                  n: n(data.models.reduce((s, m) => s + m.requests, 0)),
                })}
              </span>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Section
              className="lg:col-span-2"
              title={t('billing.profit.byModel')}
              help={t('billing.profit.byModelHelp')}
            >
              {data.models.length === 0 ? (
                <p className="text-sm text-muted">{t('billing.profit.none')}</p>
              ) : (
                <DataTable
                  testId="profit-table"
                  minWidth={760}
                  caption={t('billing.profit.byModel')}
                  columns={[
                    { key: 'model', label: t('billing.profit.col.model') },
                    { key: 'requests', label: t('billing.profit.col.requests'), numeric: true },
                    { key: 'cost', label: t('billing.profit.col.cost'), numeric: true },
                    { key: 'revenue', label: t('billing.profit.col.revenue'), numeric: true },
                    { key: 'profit', label: t('billing.profit.col.profit'), numeric: true },
                    { key: 'margin', label: t('billing.profit.col.margin'), numeric: true },
                  ]}
                >
                  {data.models.map((m) => (
                    <tr
                      key={`${m.model}|${m.providerId}`}
                      className={rowClass}
                      data-testid="profit-row"
                    >
                      <td className={cellClass}>
                        <code dir="ltr" className="text-[13px]">
                          {m.model}
                        </code>
                        <p className="text-xs text-muted" dir="ltr">
                          {m.providerId}
                        </p>
                      </td>
                      <td className={numClass}>{n(m.requests)}</td>
                      <td className={numClass}>
                        <Money value={m.costUsd} />
                      </td>
                      <td className={numClass}>
                        <Money value={m.revenueUsd} />
                      </td>
                      <td
                        className={`${numClass} ${m.profitUsd.startsWith('-') ? 'text-danger' : ''}`}
                      >
                        <Money value={m.profitUsd} />
                      </td>
                      <td className={numClass}>
                        {m.marginPercent === null ? '—' : `${n(m.marginPercent)}%`}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Section>
            <Section title={t('billing.profit.chart')}>
              <BarList
                testId="profit-bars"
                empty={t('billing.profit.none')}
                items={data.models
                  .filter((m) => Number(m.profitUsd) > 0)
                  .map((m) => ({
                    id: `${m.model}|${m.providerId}`,
                    label: m.model,
                    value: Number(m.profitUsd),
                    display: `$${trimUsd(m.profitUsd)}`,
                    meta: m.marginPercent === null ? undefined : `${n(m.marginPercent)}%`,
                  }))}
              />
            </Section>
          </div>

          <Section title={t('billing.profit.ledger')} help={t('billing.profit.ledgerHelp')}>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="profit-ledger">
              {(
                ['revenueBookedUsd', 'fundsReceivedUsd', 'promoGivenUsd', 'writtenOffUsd'] as const
              ).map((key) => (
                <div key={key} className="rounded-lg bg-surface-2/60 px-4 py-3">
                  <dt className="text-[13px] text-fg-2">{t(`billing.profit.ledgerKeys.${key}`)}</dt>
                  <dd className="mt-1 text-lg font-medium">
                    <Money value={data.ledger[key]} />
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
        </>
      )}
    </div>
  );
}

/** A report total exactly as the endpoint sent it (the tooltip and `data-exact` keep 8 decimals). */
function Total({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card className="flex flex-col gap-2">
      <span className="text-[13px] text-fg-2">{label}</span>
      <span data-testid={testId} className="text-2xl leading-none font-medium">
        <Money value={value} />
      </span>
      <span className="num text-xs text-muted" dir="ltr">
        {trimUsd(value)}
      </span>
    </Card>
  );
}
