/**
 * Request Log (پایهٔ کارت ۷.۷): فهرست درخواست‌ها با فیلترهای داخل URL، تا drill-down از
 * Overview (کارت ۷.۳) و لینک‌دادن قابل اشتراک باشد. صفحه‌بندی با cursor.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Empty, ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/date';
import { rangeBounds, useRange } from '../lib/range';
import { LOG_FILTERS as FILTERS, type LogSearch } from '../lib/log-search';
import { currentOrg, useSession } from '../lib/session';
import { useSettings } from '../settings';

interface LogItem {
  id: string;
  createdAt: string;
  requestedModel: string;
  apiKeyId: string;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number;
  stream: boolean;
}

export default function LogsPage() {
  const { t } = useTranslation();
  const s = useSettings();
  useSession();
  const org = currentOrg();
  const search: LogSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const range = useRange();
  // بدون from/to، بازهٔ سراسری داشبورد
  const fallback = rangeBounds(range);
  const from = search.from ?? fallback.from;
  const to = search.to ?? fallback.to;

  const params = new URLSearchParams({ from, to, limit: '50' });
  for (const k of FILTERS) {
    const v = search[k];
    if (v) params.set(k, v);
  }
  const query = useInfiniteQuery({
    queryKey: ['logs', org?.id, params.toString()],
    enabled: Boolean(org),
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<{ items: LogItem[]; nextCursor: string | null }>(
        `/orgs/${org?.id ?? ''}/logs?${params.toString()}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const date = (v: string) =>
    formatDate(v, { calendar: s.calendar, lang: s.lang, time: true, seconds: true });
  const n = (v: number) => formatNumber(v, s.lang);
  const clear = (k: (typeof FILTERS)[number] | 'range') => {
    const next = Object.fromEntries(
      Object.entries(search).filter(([key]) =>
        k === 'range' ? key !== 'from' && key !== 'to' : key !== k,
      ),
    ) as LogSearch;
    void navigate({ to: '/logs', search: next });
  };
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">{t('logs.title')}</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="log-filters">
        <span className="rounded-full border border-border px-2 py-0.5">
          {date(from)} — {date(to)}
          {(search.from ?? search.to) && (
            <button
              type="button"
              className="ms-1 text-muted"
              aria-label={t('logs.clear')}
              onClick={() => {
                clear('range');
              }}
            >
              ×
            </button>
          )}
        </span>
        {FILTERS.filter((k) => search[k]).map((k) => (
          <span key={k} className="rounded-full bg-surface-2 px-2 py-0.5">
            {t(`logs.filter.${k}`)}:{' '}
            <span dir="ltr">
              {k === 'status' ? t(`logs.status.${search[k] ?? ''}`) : search[k]}
            </span>
            <button
              type="button"
              className="ms-1 text-muted"
              aria-label={t('logs.clear')}
              onClick={() => {
                clear(k);
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title={t('logs.empty')} />
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-muted">
              <tr className="border-b border-border text-start">
                {(['time', 'model', 'status', 'tokens', 'cost', 'latency'] as const).map((c) => (
                  <th key={c} className="px-3 py-2 text-start font-medium">
                    {t(`logs.col.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60" data-testid="log-row">
                  <td className="whitespace-nowrap px-3 py-1.5">{date(r.createdAt)}</td>
                  <td className="px-3 py-1.5" dir="ltr">
                    {r.requestedModel}
                    {r.stream && <span className="ms-1 text-xs text-muted">SSE</span>}
                  </td>
                  <td
                    className={`px-3 py-1.5 ${r.status === 'success' ? 'text-emerald-600' : 'text-danger'}`}
                  >
                    {n(r.httpStatus)}
                    {r.errorCode && <span className="ms-1 text-xs">{r.errorCode}</span>}
                  </td>
                  <td className="px-3 py-1.5">{n(r.inputTokens + r.outputTokens)}</td>
                  <td className="px-3 py-1.5" dir="ltr">
                    ${Number(r.costUsd).toFixed(6)}
                  </td>
                  <td className="px-3 py-1.5">
                    {n(r.latencyMs)} {t('overview.ms')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {query.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {t('logs.more')}
        </Button>
      )}
    </section>
  );
}
