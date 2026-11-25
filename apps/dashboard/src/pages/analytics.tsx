/**
 * Usage analytics (card 16.4): KPIs, a trend chart with a selectable metric, and breakdowns by
 * model, key, project and provider. Every chart column and every breakdown row opens the Request
 * Log filtered to the same slice (drill-down).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Download } from 'lucide-react';

import { BarList } from '../components/charts/bar-list';
import { TrendChart } from '../components/charts/trend-chart';
import { PageHeader, RangeTabs, Section, Segmented, Stat } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { downloadCsv } from '../lib/csv';
import { useFormat } from '../lib/s2-format';
import { formatDate, formatTick } from '../lib/date';
import type { LogSearch } from '../lib/log-search';
import { rangeBounds, useRange } from '../lib/range';
import { currentOrg } from '../lib/session';
import { DRILL, metricValue } from '../lib/s2-helpers';

interface TopItem {
  id: string;
  requests: number;
  errors?: number;
  tokens?: number;
  costUsd: string;
}

interface Point {
  bucket: string;
  requests: number;
  errors: number;
  costUsd: string;
  inputTokens?: number;
  outputTokens?: number;
}
interface Analytics {
  overview: { requests: number; errorRate: number; costUsd: string; latencyP95Ms: number | null };
  series: { points: Point[] };
  byModel: { items: TopItem[] };
  byKey: { items: TopItem[] };
  byProject: { items: TopItem[] };
  byProvider: { items: TopItem[] };
}
const METRICS = ['requests', 'cost', 'errors', 'tokens'] as const;
type Metric = (typeof METRICS)[number];
export default function AnalyticsPage() {
  const { t } = useTranslation();
  const { n, usd, percent, settings } = useFormat();
  const navigate = useNavigate();
  const org = currentOrg();
  const range = useRange();
  const bounds = rangeBounds(range);
  const [metric, setMetric] = useState<Metric>('requests');
  const query = useQuery({
    queryKey: ['analytics', org?.id, bounds.from, bounds.to, bounds.granularity],
    queryFn: () =>
      api<Analytics>(`/orgs/${org?.id ?? ''}/stats/analytics`, {
        query: { from: bounds.from, to: bounds.to, granularity: bounds.granularity },
      }),
    enabled: Boolean(org),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Loading />;
  const data = query.data;
  const toLogs = (search: LogSearch) =>
    void navigate({ to: '/logs', search: { from: bounds.from, to: bounds.to, ...search } });
  const format = (value: number) => (metric === 'cost' ? usd(value) : n(value));

  const totalCost = data.byModel.items.reduce((sum, item) => sum + Number(item.costUsd), 0);
  const col = (key: string) => t(`s2.analytics.col.${key}`);
  const breakdown = (group: keyof typeof DRILL) =>
    data[group].items.map((item) => ({
      id: item.id,
      label: item.id,
      value: metric === 'cost' ? Number(item.costUsd) : item.requests,
      display: metric === 'cost' ? usd(item.costUsd) : n(item.requests),
      meta: metric === 'cost' ? n(item.requests) : usd(item.costUsd),
    }));

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('s2.analytics.title')} subtitle={t('s2.analytics.subtitle')}>
        <RangeTabs />
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          size="lg"
          label={t('s2.analytics.metric.requests')}
          value={n(data.overview.requests)}
        />
        <Stat size="lg" label={t('s2.analytics.metric.cost')} value={usd(data.overview.costUsd)} />
        <Stat
          size="lg"
          label={t('s2.analytics.errorRate')}
          value={percent(data.overview.errorRate)}
        />
        <Stat
          size="lg"
          label={t('s2.analytics.p95')}
          value={
            data.overview.latencyP95Ms === null
              ? '—'
              : `${n(data.overview.latencyP95Ms)} ${t('overview.ms')}`
          }
        />
      </div>

      <Section
        title={t('s2.analytics.trend')}
        action={
          <Segmented
            size="sm"
            value={metric}
            onChange={setMetric}
            options={METRICS.map((key) => ({ value: key, label: t(`s2.analytics.metric.${key}`) }))}
          />
        }
      >
        <TrendChart
          kind="bars"
          height={300}
          ariaLabel={t('s2.analytics.trend')}
          seriesLabel={t(`s2.analytics.metric.${metric}`)}
          secondaryLabel={t('s2.analytics.metric.errors')}
          format={format}
          axisFormat={(v) =>
            metric === 'cost'
              ? n(v, { style: 'currency', currency: 'USD', notation: 'compact' })
              : n(v, { notation: 'compact', maximumFractionDigits: 1 })
          }
          points={data.series.points.map((point) => ({
            label: formatDate(point.bucket, {
              calendar: settings.calendar,
              lang: settings.lang,
              time: bounds.granularity === 'hour',
            }),
            tick: formatTick(point.bucket, {
              calendar: settings.calendar,
              lang: settings.lang,
              hourly: bounds.granularity === 'hour',
            }),
            value: metricValue(point, metric),
            ...(metric === 'requests' ? { secondary: point.errors } : {}),
          }))}
          onSelect={(index) => {
            const point = data.series.points[index];
            if (!point) return;
            const from = new Date(point.bucket).getTime();
            toLogs({
              from: new Date(from).toISOString(),
              to: new Date(from + bounds.bucketMs).toISOString(),
              ...(metric === 'errors' ? { status: 'error' as const } : {}),
            });
          }}
        />
      </Section>

      <div className="grid gap-4 md:grid-cols-2">
        {(Object.keys(DRILL) as (keyof typeof DRILL)[]).map((group) => (
          <Section key={group} title={t(`s2.analytics.${group}`)}>
            <BarList
              testId={`analytics-${group}`}
              tone={group === 'byModel' ? 'brand' : 'neutral'}
              items={breakdown(group)}
              empty={t('s2.common.none')}
              onSelect={(id) => {
                toLogs({ [DRILL[group]]: id });
              }}
            />
          </Section>
        ))}
      </div>

      <Section
        title={t('s2.analytics.report')}
        help={t('s2.analytics.reportHelp')}
        action={
          <Button
            variant="outline"
            disabled={data.byModel.items.length === 0}
            onClick={() => {
              downloadCsv(
                `dirouter-usage-${bounds.from.slice(0, 10)}_${bounds.to.slice(0, 10)}.csv`,
                ['model', 'requests', 'errors', 'tokens', 'cost_usd'],
                data.byModel.items.map((item) => [
                  item.id,
                  item.requests,
                  item.errors ?? 0,
                  item.tokens ?? 0,
                  item.costUsd,
                ]),
              );
            }}
          >
            <Download aria-hidden className="size-4" strokeWidth={1.5} />
            {t('s2.analytics.export')}
          </Button>
        }
      >
        {data.byModel.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-y border-border bg-surface-2/60 text-xs">
                  <th className="px-5 py-2.5 text-start">{col('model')}</th>
                  <th className="px-3 py-2.5 text-end">{col('requests')}</th>
                  <th className="px-3 py-2.5 text-end">{col('errors')}</th>
                  <th className="px-3 py-2.5 text-end">{col('errorRate')}</th>
                  <th className="px-3 py-2.5 text-end">{col('tokens')}</th>
                  <th className="px-3 py-2.5 text-end">{col('cost')}</th>
                  <th className="w-56 px-5 py-2.5 text-start">{col('share')}</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.items.map((item) => {
                  const share = totalCost > 0 ? Number(item.costUsd) / totalCost : 0;
                  return (
                    <tr
                      key={item.id}
                      className="cursor-pointer border-b border-border transition-colors duration-150 last:border-0 hover:bg-surface-2/60"
                      onClick={() => {
                        toLogs({ model: item.id });
                      }}
                    >
                      <td className="px-5 py-3 font-mono" dir="ltr">
                        <bdi>{item.id}</bdi>
                      </td>
                      <td className="num px-3 py-3 text-end">{n(item.requests)}</td>
                      <td className="num px-3 py-3 text-end text-fg-2">{n(item.errors ?? 0)}</td>
                      <td className="num px-3 py-3 text-end text-fg-2">
                        {percent(item.requests > 0 ? (item.errors ?? 0) / item.requests : 0)}
                      </td>
                      <td className="num px-3 py-3 text-end text-fg-2">
                        {n(item.tokens ?? 0, { notation: 'compact', maximumFractionDigits: 1 })}
                      </td>
                      <td className="num px-3 py-3 text-end font-medium">{usd(item.costUsd)}</td>
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-3">
                          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                            <span
                              className="block h-full rounded-full bg-chart-1"
                              style={{ width: `${String(share * 100)}%` }}
                            />
                          </span>
                          <span className="num w-12 text-end text-fg-2">{percent(share)}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </section>
  );
}
