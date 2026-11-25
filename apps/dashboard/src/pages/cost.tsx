/**
 * Cost and budgets (card 16.1): period cost from the rollups next to the ledger total, cost per
 * day, top models, budget status for the current period, cache savings (cards 13.1-13.3), the
 * semantic cache and the latest ledger entries.
 *
 * Rollups lag the ledger by up to a rollup interval, so the two totals are only compared over
 * buckets that are already closed (`settledWindow`); what the ledger holds after that is shown as
 * pending aggregation.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { CircleCheck } from 'lucide-react';

import { BarList } from '../components/charts/bar-list';
import { TrendChart } from '../components/charts/trend-chart';
import { PageHeader, RangeTabs, Section, Stat } from '../components/s2/common';
import { SemanticCacheSection } from '../components/s2/semantic-cache';
import { ScopeUsageSection } from '../components/scope-usage';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { useFormat } from '../lib/s2-format';
import { formatDate, formatTick } from '../lib/date';
import type { LogSearch } from '../lib/log-search';
import { rangeBounds, useRange } from '../lib/range';
import { currentOrg } from '../lib/session';
import { reconcile, settledWindow } from '../lib/s2-helpers';

interface CostData {
  overview: { requests: number; costUsd: string };
  series: { points: { bucket: string; costUsd: string; requests: number }[] };
  top: { items: { id: string; requests: number; costUsd: string }[] };
  ledger: {
    rows: {
      id: string;
      requestId: string;
      projectId: string;
      apiKeyId: string;
      tokens: number;
      costUsd: string;
      occurredAt: string;
    }[];
  };
  ledgerTotal: { entries: number; costUsd: string; tokens: number };
  budgets: {
    id: string;
    scope: 'key' | 'project' | 'team';
    scopeId: string;
    period: 'daily' | 'monthly';
    limitUsd: string | null;
    spentUsd: string;
    usedPercent: number | null;
  }[];
}
interface CacheData {
  requests: number;
  hits: number;
  hitRate: number;
  compressedInputTokens: number;
  kinds: { kind: 'exact' | 'semantic'; hits: number; hitRate: number; savedUsd: string }[];
}

export default function CostPage() {
  const { t } = useTranslation();
  const { n, usd, percent, settings } = useFormat();
  const navigate = useNavigate();
  const org = currentOrg();
  const range = useRange();
  const bounds = rangeBounds(range);
  const base = `/orgs/${org?.id ?? ''}`;
  const query = { from: bounds.from, to: bounds.to };
  const options = {
    enabled: Boolean(org),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  };

  const cost = useQuery({
    queryKey: ['cost', org?.id, bounds.from, bounds.to],
    queryFn: () => api<CostData>(`${base}/stats/cost`, { query }),
    ...options,
  });
  // Recomputed on every render; the value only changes when a bucket closes, so the key is stable.
  const settled = settledWindow(bounds.from, bounds.to);
  const settledCost = useQuery({
    queryKey: ['cost-settled', org?.id, bounds.from, settled?.to],
    queryFn: () =>
      api<CostData>(`${base}/stats/cost`, { query: { from: bounds.from, to: settled?.to } }),
    ...options,
    enabled: Boolean(org) && settled !== undefined,
  });
  const cache = useQuery({
    queryKey: ['cache-stats', org?.id, bounds.from, bounds.to],
    queryFn: () => api<CacheData>(`${base}/stats/cache`, { query }),
    ...options,
  });

  if (cost.isError) return <ErrorState error={cost.error} onRetry={() => void cost.refetch()} />;
  if (!cost.data) return <Loading />;
  const data = cost.data;
  const toLogs = (search: LogSearch) =>
    void navigate({ to: '/logs', search: { ...query, ...search } });
  const check =
    settled && settledCost.data
      ? reconcile(
          {
            rollupUsd: settledCost.data.overview.costUsd,
            ledgerUsd: settledCost.data.ledgerTotal.costUsd,
          },
          data.ledgerTotal.costUsd,
        )
      : undefined;
  const boundary = settled
    ? formatDate(settled.boundary, {
        calendar: settings.calendar,
        lang: settings.lang,
        time: true,
      })
    : '';

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('s2.cost.title')} subtitle={t('s2.cost.subtitle')}>
        <RangeTabs />
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat size="lg" label={t('s2.cost.total')} value={usd(data.overview.costUsd)} />
        <Stat
          size="lg"
          label={t('s2.cost.ledger')}
          value={usd(data.ledgerTotal.costUsd)}
          hint={t('s2.cost.ledgerEntries', { n: n(data.ledgerTotal.entries) })}
        />
        <Stat size="lg" label={t('s2.cost.requests')} value={n(data.overview.requests)} />
      </div>
      <div
        data-testid="ledger-reconciliation"
        className="-mt-2 flex flex-col gap-1 rounded-lg bg-surface-2/60 px-4 py-2.5 text-[13px]"
      >
        {!settled ? (
          <p className="text-muted">{t('s2.cost.noSettled')}</p>
        ) : settledCost.isError ? (
          <p className="text-muted">{t('s2.cost.checkFailed')}</p>
        ) : !check ? (
          <p className="text-muted">{t('s2.cost.checking')}</p>
        ) : check.matches ? (
          <p className="flex items-center gap-2 text-good">
            <CircleCheck aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
            {t('s2.cost.match', { time: boundary })}
          </p>
        ) : (
          <p className="text-danger">
            {t('s2.cost.mismatch', { diff: usd(check.diffUsd), time: boundary })}{' '}
            {t('s2.cost.mismatchHelp')}
          </p>
        )}
        {check && check.pendingUsd > 0 ? (
          <p data-testid="ledger-pending" className="text-muted">
            {t('s2.cost.pending', { amount: usd(check.pendingUsd), time: boundary })}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section className="lg:col-span-2" title={t('s2.cost.perDay')}>
          <TrendChart
            kind="bars"
            ariaLabel={t('s2.cost.perDay')}
            seriesLabel={t('s2.cost.total')}
            format={(value) => usd(value)}
            axisFormat={(value) =>
              n(value, { style: 'currency', currency: 'USD', notation: 'compact' })
            }
            points={data.series.points.map((point) => ({
              label: formatDate(point.bucket, { calendar: settings.calendar, lang: settings.lang }),
              tick: formatTick(point.bucket, {
                calendar: settings.calendar,
                lang: settings.lang,
                hourly: false,
              }),
              value: Number(point.costUsd),
            }))}
            onSelect={(index) => {
              const point = data.series.points[index];
              if (!point) return;
              const from = new Date(point.bucket);
              toLogs({
                from: from.toISOString(),
                to: new Date(from.getTime() + 86_400_000).toISOString(),
              });
            }}
          />
        </Section>
        <Section title={t('s2.cost.topModels')}>
          <BarList
            empty={t('s2.common.none')}
            items={data.top.items.map((item) => ({
              id: item.id,
              label: item.id,
              value: Number(item.costUsd),
              display: usd(item.costUsd),
              meta: n(item.requests),
            }))}
            onSelect={(id) => {
              toLogs({ model: id });
            }}
          />
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('s2.cost.cache')}>
          {cache.data ? (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                {t('s2.cost.hitRate')}: <strong>{percent(cache.data.hitRate)}</strong>{' '}
                <span className="text-muted">({t('s2.cost.hits', { n: n(cache.data.hits) })})</span>
              </p>
              {cache.data.kinds.map((kind) => (
                <p
                  key={kind.kind}
                  data-testid={`cache-${kind.kind}`}
                  className="flex justify-between border-t border-border pt-1.5"
                >
                  <span>
                    {t(`s2.cost.kind.${kind.kind}`)} · {percent(kind.hitRate)}
                  </span>
                  <span className="text-muted">
                    {t('s2.cost.saved')}: {usd(kind.savedUsd)}
                  </span>
                </p>
              ))}
              <p className="flex justify-between border-t border-border pt-1.5">
                <span>{t('s2.cost.compressed')}</span>
                <span className="text-muted">{n(cache.data.compressedInputTokens)}</span>
              </p>
            </div>
          ) : cache.isError ? (
            <ErrorState error={cache.error} onRetry={() => void cache.refetch()} />
          ) : (
            <Loading />
          )}
        </Section>
      </div>

      <Section title={t('s2.cost.budgets')} help={t('s2.cost.budgetHelp')}>
        {data.budgets.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <ul data-testid="budget-list" className="flex flex-col gap-3">
            {data.budgets.map((budget) => {
              const used = budget.usedPercent ?? 0;
              return (
                <li key={budget.id} className="text-sm">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span>
                      {t(`s2.cost.scope.${budget.scope}`)} <span dir="ltr">{budget.scopeId}</span> ·{' '}
                      {t(`s2.cost.period.${budget.period}`)}
                    </span>
                    <span className="text-muted">
                      {usd(budget.spentUsd)} /{' '}
                      {budget.limitUsd === null ? t('s2.cost.noLimit') : usd(budget.limitUsd)}
                    </span>
                  </div>
                  {budget.limitUsd === null ? null : (
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(100, used)}
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2"
                    >
                      <div
                        className={`h-full rounded-full ${used >= 100 ? 'bg-danger' : used >= 80 ? 'bg-warn' : 'bg-chart-1'}`}
                        style={{ width: `${String(Math.min(100, used))}%` }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {org ? <ScopeUsageSection orgId={org.id} /> : null}

      {org ? <SemanticCacheSection orgId={org.id} /> : null}

      <Section title={t('s2.cost.recent')}>
        {data.ledger.rows.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="py-1 text-start font-medium">{t('s2.cost.when')}</th>
                  <th className="py-1 text-start font-medium">{t('s2.cost.request')}</th>
                  <th className="py-1 text-end font-medium">{t('s2.cost.tokens')}</th>
                  <th className="py-1 text-end font-medium">{t('s2.cost.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.rows.slice(0, 25).map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="whitespace-nowrap py-1.5">
                      {formatDate(row.occurredAt, {
                        calendar: settings.calendar,
                        lang: settings.lang,
                        time: true,
                      })}
                    </td>
                    <td className="py-1.5" dir="ltr">
                      {row.requestId}
                    </td>
                    <td className="py-1.5 text-end">{n(row.tokens)}</td>
                    <td className="py-1.5 text-end">{usd(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </section>
  );
}
