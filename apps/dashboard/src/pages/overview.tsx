/**
 * Overview page (card 7.3): KPIs compared with the previous period, time-series chart, top models and
 * keys and projects, provider status. The time range is global and refreshes every 30 seconds.
 * Clicking a chart column or top row goes to Request Log with the same filter.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BarList } from '../components/charts/bar-list';
import { ShareBar } from '../components/charts/share-bar';
import { TrendChart } from '../components/charts/trend-chart';
import { Delta, PageHeader, RangeTabs, Section, Segmented, Stat } from '../components/s2/common';
import { Card } from '../components/ui/card';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate, formatNumber, formatTick } from '../lib/date';
import { rangeBounds, useRange } from '../lib/range';
import { currentOrg, useSession } from '../lib/session';
import { useSettings } from '../settings';
import type { LogSearch } from '../lib/log-search';

interface Overview {
  requests: number;
  errors: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  avgTtftMs: number | null;
  activeKeys: number;
}
interface Series {
  points: {
    bucket: string;
    requests: number;
    errors: number;
    costUsd: string;
    inputTokens?: number;
    outputTokens?: number;
    avgLatencyMs?: number | null;
  }[];
}
interface Top {
  items: { id: string; requests: number; costUsd: string }[];
}
interface Runtime {
  providers: { id: string; name: string; breaker: { state: string } | null }[];
}

const REFRESH_MS = 30_000;

function useTop(
  base: string,
  by: 'model' | 'key' | 'project',
  b: { from: string; to: string },
  opts: { enabled: boolean; refetchInterval: number; placeholderData: typeof keepPreviousData },
  orgId: string | undefined,
) {
  return useQuery({
    queryKey: ['top', orgId, by, b.from, b.to],
    queryFn: () =>
      api<Top>(
        `${base}/stats/top?from=${encodeURIComponent(b.from)}&to=${encodeURIComponent(b.to)}&by=${by}&metric=cost&limit=5`,
      ),
    ...opts,
  });
}
const METRICS = ['requests', 'cost', 'errors', 'tokens', 'latency'] as const;
type Metric = (typeof METRICS)[number];

export default function OverviewPage() {
  const { t } = useTranslation();
  const s = useSettings();
  useSession();
  const org = currentOrg();
  const range = useRange();
  const navigate = useNavigate();
  const [metric, setMetric] = useState<Metric>('requests');
  const b = rangeBounds(range);
  const base = `/orgs/${org?.id ?? ''}`;
  const q = (from: string, to: string) =>
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const opts = {
    enabled: Boolean(org),
    refetchInterval: REFRESH_MS,
    // the previous data is kept when the range changes so the page does not flicker.
    placeholderData: keepPreviousData,
  };

  const now = useQuery({
    queryKey: ['overview', org?.id, b.from, b.to],
    queryFn: () => api<Overview>(`${base}/stats/overview?${q(b.from, b.to)}`),
    ...opts,
  });
  const prev = useQuery({
    queryKey: ['overview', org?.id, b.prevFrom, b.prevTo],
    queryFn: () => api<Overview>(`${base}/stats/overview?${q(b.prevFrom, b.prevTo)}`),
    ...opts,
  });
  const series = useQuery({
    queryKey: ['series', org?.id, b.from, b.to, b.granularity],
    queryFn: () =>
      api<Series>(`${base}/stats/timeseries?${q(b.from, b.to)}&granularity=${b.granularity}`),
    ...opts,
  });
  const tops = {
    model: useTop(base, 'model', b, opts, org?.id),
    key: useTop(base, 'key', b, opts, org?.id),
    project: useTop(base, 'project', b, opts, org?.id),
  };
  const runtime = useQuery({
    queryKey: ['health', org?.id],
    queryFn: () => api<Runtime>(`${base}/health/runtime`),
    ...opts,
    retry: false,
  });

  if (now.isError) return <ErrorState error={now.error} onRetry={() => void now.refetch()} />;
  if (!now.data) return <Loading />;

  const n = (v: number, o: Intl.NumberFormatOptions = {}) => formatNumber(v, s.lang, o);
  const usd = (v: number) =>
    n(v, { style: 'currency', currency: 'USD', maximumFractionDigits: v < 1 ? 4 : 2 });
  const ms = (v: number | null) => (v === null ? '—' : `${n(v)} ${t('overview.ms')}`);
  const cur = now.data;
  const old = prev.data;
  const delta = (a: number, z: number | undefined) =>
    z === undefined || z === 0 ? undefined : (a - z) / z;

  const kpis: { key: string; value: string; change?: number | undefined; goodWhenUp?: boolean }[] =
    [
      {
        key: 'requests',
        value: n(cur.requests),
        change: delta(cur.requests, old?.requests),
        goodWhenUp: true,
      },
      {
        key: 'tokens',
        value: n(cur.inputTokens + cur.outputTokens, { notation: 'compact' }),
        change: delta(
          cur.inputTokens + cur.outputTokens,
          old ? old.inputTokens + old.outputTokens : undefined,
        ),
        goodWhenUp: true,
      },
      {
        key: 'cost',
        value: usd(Number(cur.costUsd)),
        change: delta(Number(cur.costUsd), old ? Number(old.costUsd) : undefined),
      },
      {
        key: 'errorRate',
        value: n(cur.errorRate, { style: 'percent', maximumFractionDigits: 1 }),
        change: delta(cur.errorRate, old?.errorRate),
      },
      {
        key: 'p50',
        value: ms(cur.latencyP50Ms),
        change: delta(cur.latencyP50Ms ?? 0, old?.latencyP50Ms ?? undefined),
      },
      {
        key: 'p95',
        value: ms(cur.latencyP95Ms),
        change: delta(cur.latencyP95Ms ?? 0, old?.latencyP95Ms ?? undefined),
      },
      {
        key: 'ttft',
        value: ms(cur.avgTtftMs),
        change: delta(cur.avgTtftMs ?? 0, old?.avgTtftMs ?? undefined),
      },
      {
        key: 'activeKeys',
        value: n(cur.activeKeys),
        change: delta(cur.activeKeys, old?.activeKeys),
        goodWhenUp: true,
      },
    ];

  const points = series.data?.points ?? [];
  const valueOf = (p: Series['points'][number]) =>
    metric === 'cost'
      ? Number(p.costUsd)
      : metric === 'errors'
        ? p.errors
        : metric === 'tokens'
          ? (p.inputTokens ?? 0) + (p.outputTokens ?? 0)
          : metric === 'latency'
            ? (p.avgLatencyMs ?? 0)
            : p.requests;
  const trend = points.map((p) => ({
    label: formatDate(p.bucket, {
      calendar: s.calendar,
      lang: s.lang,
      time: b.granularity === 'hour',
    }),
    tick: formatTick(p.bucket, {
      calendar: s.calendar,
      lang: s.lang,
      hourly: b.granularity === 'hour',
    }),
    value: valueOf(p),
    ...(metric === 'requests' ? { secondary: p.errors } : {}),
  }));
  const formatMetric = (v: number) =>
    metric === 'cost' ? usd(v) : metric === 'latency' ? ms(Math.round(v)) : n(v);
  const compact = (v: number) =>
    metric === 'cost'
      ? n(v, { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 })
      : n(v, { notation: 'compact', maximumFractionDigits: 1 });
  const percent = (v: number) => n(v, { style: 'percent', maximumFractionDigits: 1 });
  const toLogs = (search: LogSearch) => void navigate({ to: '/logs', search });
  const tile = (key: string) => {
    const k = kpis.find((x) => x.key === key);
    if (!k) return null;
    const good =
      k.change === undefined
        ? true
        : k.goodWhenUp === undefined
          ? k.change <= 0
          : k.change > 0 === k.goodWhenUp;
    return {
      label: t(`overview.kpi.${k.key}`),
      value: k.value,
      testId: `kpi-${k.key}`,
      delta:
        k.change === undefined ? undefined : (
          <Delta
            up={k.change > 0}
            good={good}
            text={t('overview.vsPrevious', {
              change: n(k.change, {
                style: 'percent',
                maximumFractionDigits: 0,
                signDisplay: 'exceptZero',
              }),
            })}
          />
        ),
    };
  };
  const topList = (by: 'model' | 'key' | 'project') =>
    (tops[by].data?.items ?? []).map((item) => ({
      id: item.id,
      label: item.id,
      value: Number(item.costUsd),
      display: usd(Number(item.costUsd)),
      meta: n(item.requests),
    }));
  const drillTop = (by: 'model' | 'key' | 'project') => (id: string) => {
    toLogs({
      from: b.from,
      to: b.to,
      ...(by === 'model' ? { model: id } : by === 'key' ? { apiKeyId: id } : { projectId: id }),
    });
  };

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('overview.title')}>
        <RangeTabs />
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {(['requests', 'cost', 'errorRate', 'p95'] as const).map((key) => {
          const k = tile(key);
          return k ? <Stat key={key} size="lg" {...k} /> : null;
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Section
          className="lg:col-span-2"
          title={t('overview.chart')}
          help={t('overview.drillHint')}
          action={
            <Segmented
              mode="toggle"
              size="sm"
              value={metric}
              onChange={setMetric}
              options={METRICS.map((m) => ({ value: m, label: t(`overview.metric.${m}`) }))}
            />
          }
        >
          {points.length === 0 ? (
            <p className="py-24 text-center text-sm text-muted">{t('overview.noData')}</p>
          ) : (
            <TrendChart
              kind={metric === 'errors' ? 'bars' : 'area'}
              points={trend}
              ariaLabel={t('overview.chart')}
              seriesLabel={t(`overview.metric.${metric}`)}
              secondaryLabel={t('overview.metric.errors')}
              format={formatMetric}
              axisFormat={metric === 'latency' ? (v) => n(v) : compact}
              onSelect={(i) => {
                const p = points[i];
                if (!p) return;
                toLogs({
                  from: new Date(Date.parse(p.bucket)).toISOString(),
                  to: new Date(Date.parse(p.bucket) + b.bucketMs).toISOString(),
                  ...(metric === 'errors' ? { status: 'error' as const } : {}),
                });
              }}
            />
          )}
        </Section>
        <Section title={t('overview.top.model')}>
          <BarList
            items={topList('model')}
            empty={t('overview.noData')}
            onSelect={drillTop('model')}
          />
        </Section>
      </div>

      <Card className="grid grid-cols-2 gap-y-5 p-0 lg:grid-cols-4 lg:divide-x lg:divide-border rtl:lg:divide-x-reverse">
        {(['tokens', 'p50', 'ttft', 'activeKeys'] as const).map((key) => {
          const k = tile(key);
          return k ? (
            <div key={key} className="flex flex-col gap-1.5 px-5 py-4">
              <span className="text-[13px] text-fg-2">{k.label}</span>
              <span data-testid={k.testId} className="num text-xl leading-none font-medium">
                <bdi>{k.value}</bdi>
              </span>
              {k.delta}
            </div>
          ) : null;
        })}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4">
          <Section title={t('overview.outcomes')}>
            <ShareBar
              ariaLabel={t('overview.outcomes')}
              percent={percent}
              parts={[
                {
                  label: t('overview.succeeded'),
                  value: cur.requests - cur.errors,
                  display: n(cur.requests - cur.errors),
                  color: 'bg-chart-3',
                },
                {
                  label: t('overview.failed'),
                  value: cur.errors,
                  display: n(cur.errors),
                  color: 'bg-danger',
                },
              ]}
            />
          </Section>
          <Section title={t('overview.tokenMix')}>
            <ShareBar
              ariaLabel={t('overview.tokenMix')}
              percent={percent}
              parts={[
                {
                  label: t('overview.input'),
                  value: cur.inputTokens,
                  display: n(cur.inputTokens, { notation: 'compact' }),
                  color: 'bg-chart-1',
                },
                {
                  label: t('overview.output'),
                  value: cur.outputTokens,
                  display: n(cur.outputTokens, { notation: 'compact' }),
                  color: 'bg-chart-2',
                },
              ]}
            />
          </Section>
        </div>
        {(['key', 'project'] as const).map((by) => (
          <Section key={by} title={t(`overview.top.${by}`)}>
            <BarList
              tone="neutral"
              items={topList(by)}
              empty={t('overview.noData')}
              onSelect={drillTop(by)}
            />
          </Section>
        ))}
      </div>

      {runtime.data?.providers && (
        <Section title={t('overview.providers')}>
          <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {runtime.data.providers.map((p) => {
              const state = p.breaker?.state ?? 'closed';
              return (
                <li key={p.id} className="flex items-center gap-2.5 text-[13px]">
                  <span
                    aria-hidden
                    className={`lamp ${state === 'closed' ? 'text-good' : state === 'open' ? 'text-danger' : 'text-warn'}`}
                  />
                  <span className="min-w-0 truncate font-medium">{p.name}</span>
                  <span className="ms-auto shrink-0 text-muted">{t(`health.state.${state}`)}</span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
    </section>
  );
}
