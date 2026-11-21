/**
 * Usage analytics (card 16.4): KPIs, a trend chart with a selectable metric, and breakdowns by
 * model, key, project and provider. Every chart column and every breakdown row opens the Request
 * Log filtered to the same slice (drill-down).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BarChart } from '../components/charts/bar-chart';
import { PageHeader, RangeTabs, Section, Stat } from '../components/s2/common';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { useFormat } from '../lib/s2-format';
import { formatDate } from '../lib/date';
import type { LogSearch } from '../lib/log-search';
import { rangeBounds, useRange } from '../lib/range';
import { currentOrg } from '../lib/session';
import { DRILL, metricValue } from '../lib/s2-helpers';

interface TopItem {
  id: string;
  requests: number;
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

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={t('s2.analytics.title')} subtitle={t('s2.analytics.subtitle')}>
        <RangeTabs />
      </PageHeader>

      <div className="grid gap-3 md:grid-cols-4">
        <Stat label={t('s2.analytics.metric.requests')} value={n(data.overview.requests)} />
        <Stat label={t('s2.analytics.metric.cost')} value={usd(data.overview.costUsd)} />
        <Stat label={t('s2.analytics.errorRate')} value={percent(data.overview.errorRate)} />
        <Stat
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
          <div role="radiogroup" className="flex gap-1 rounded-lg border border-border p-1">
            {METRICS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={metric === key}
                onClick={() => {
                  setMetric(key);
                }}
                className={`rounded-md px-3 py-1 text-sm ${metric === key ? 'bg-brand text-white' : 'hover:bg-surface-2'}`}
              >
                {t(`s2.analytics.metric.${key}`)}
              </button>
            ))}
          </div>
        }
      >
        <BarChart
          ariaLabel={t('s2.analytics.trend')}
          format={format}
          bars={data.series.points.map((point) => ({
            label: formatDate(point.bucket, {
              calendar: settings.calendar,
              lang: settings.lang,
              time: bounds.granularity === 'hour',
            }),
            value: metricValue(point, metric),
            ...(metric === 'requests' ? { highlight: point.errors } : {}),
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

      <div className="grid gap-4 lg:grid-cols-2">
        {(Object.keys(DRILL) as (keyof typeof DRILL)[]).map((group) => (
          <Section key={group} title={t(`s2.analytics.${group}`)}>
            {data[group].items.length === 0 ? (
              <p className="text-sm text-muted">{t('s2.common.none')}</p>
            ) : (
              <ul data-testid={`analytics-${group}`} className="flex flex-col">
                {data[group].items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      title={t('s2.common.viewLogs')}
                      className="flex w-full items-center justify-between gap-2 border-t border-border py-1.5 text-sm hover:bg-border/30"
                      onClick={() => {
                        toLogs({ [DRILL[group]]: item.id });
                      }}
                    >
                      <span dir="ltr">{item.id}</span>
                      <span className="text-muted">
                        {n(item.requests)} · {usd(item.costUsd)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ))}
      </div>
    </section>
  );
}
