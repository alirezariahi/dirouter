/**
 * Overview page (card 7.3): KPIs compared with the previous period, time-series chart, top models and
 * keys and projects, provider status. The time range is global and refreshes every 30 seconds.
 * Clicking a chart column or top row goes to Request Log with the same filter.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BarChart } from '../components/charts/bar-chart';
import { Card } from '../components/ui/card';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/date';
import { RANGES, rangeBounds, setRange, useRange } from '../lib/range';
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
  points: { bucket: string; requests: number; errors: number; costUsd: string }[];
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
type Metric = 'requests' | 'cost' | 'errors';

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
  const bars = points.map((p) => ({
    label: formatDate(p.bucket, {
      calendar: s.calendar,
      lang: s.lang,
      time: b.granularity === 'hour',
    }),
    value: metric === 'cost' ? Number(p.costUsd) : metric === 'errors' ? p.errors : p.requests,
    ...(metric === 'requests' ? { highlight: p.errors } : {}),
  }));
  const toLogs = (search: LogSearch) => void navigate({ to: '/logs', search });

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t('overview.title')}</h1>
        <div
          role="radiogroup"
          aria-label={t('overview.range')}
          className="flex gap-1 rounded-lg border border-border p-1"
        >
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              onClick={() => {
                setRange(r);
              }}
              className={`rounded-md px-3 py-1 text-sm ${range === r ? 'bg-brand text-white' : 'hover:bg-surface-2'}`}
            >
              {t(`overview.ranges.${r}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.key}>
            <p className="text-sm text-muted">{t(`overview.kpi.${k.key}`)}</p>
            <p className="mt-1 text-xl font-semibold" data-testid={`kpi-${k.key}`}>
              {k.value}
            </p>
            {k.change !== undefined && (
              <p
                className={`text-xs ${
                  k.goodWhenUp === undefined
                    ? k.change > 0
                      ? 'text-danger'
                      : 'text-emerald-600'
                    : k.change > 0 === k.goodWhenUp
                      ? 'text-emerald-600'
                      : 'text-danger'
                }`}
              >
                {t('overview.vsPrevious', {
                  change: n(k.change, {
                    style: 'percent',
                    maximumFractionDigits: 0,
                    signDisplay: 'exceptZero',
                  }),
                })}
              </p>
            )}
          </Card>
        ))}
      </div>

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{t('overview.chart')}</h2>
          <div className="flex gap-1">
            {(['requests', 'cost', 'errors'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={metric === m}
                onClick={() => {
                  setMetric(m);
                }}
                className={`rounded px-2 py-0.5 text-xs ${metric === m ? 'bg-surface-2 font-semibold' : 'text-muted'}`}
              >
                {t(`overview.metric.${m}`)}
              </button>
            ))}
          </div>
        </div>
        {points.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">{t('overview.noData')}</p>
        ) : (
          <BarChart
            bars={bars}
            ariaLabel={t('overview.chart')}
            format={(v) => (metric === 'cost' ? usd(v) : n(v))}
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
        <p className="mt-1 text-xs text-muted">{t('overview.drillHint')}</p>
      </Card>

      <div className="grid gap-3 md:grid-cols-3">
        {(['model', 'key', 'project'] as const).map((by) => (
          <Card key={by}>
            <h2 className="mb-2 font-semibold">{t(`overview.top.${by}`)}</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {(tops[by].data?.items ?? []).map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="flex w-full justify-between gap-2 rounded px-1 py-0.5 text-start hover:bg-surface-2"
                    onClick={() => {
                      toLogs({
                        from: b.from,
                        to: b.to,
                        ...(by === 'model'
                          ? { model: item.id }
                          : by === 'key'
                            ? { apiKeyId: item.id }
                            : { projectId: item.id }),
                      });
                    }}
                  >
                    <span className="truncate" dir="ltr">
                      {item.id}
                    </span>
                    <span className="shrink-0 text-muted">
                      {usd(Number(item.costUsd))} · {n(item.requests)}
                    </span>
                  </button>
                </li>
              ))}
              {(tops[by].data?.items ?? []).length === 0 && (
                <li className="text-muted">{t('overview.noData')}</li>
              )}
            </ul>
          </Card>
        ))}
      </div>

      {runtime.data?.providers && (
        <Card>
          <h2 className="mb-2 font-semibold">{t('overview.providers')}</h2>
          <ul className="flex flex-wrap gap-2 text-sm">
            {runtime.data.providers.map((p) => {
              const state = p.breaker?.state ?? 'closed';
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
                >
                  <span
                    aria-hidden
                    className={`size-2 rounded-full ${state === 'closed' ? 'bg-emerald-500' : state === 'open' ? 'bg-danger' : 'bg-amber-500'}`}
                  />
                  {p.name} <span className="text-muted">({t(`health.state.${state}`)})</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
