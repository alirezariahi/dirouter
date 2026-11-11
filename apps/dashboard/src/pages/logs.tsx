import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Empty, ErrorState, Loading } from '../components/ui/states';
import { VirtualTable } from '../components/ui/virtual-table';
import { logMessages } from '../i18n/log-messages';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/date';
import { LOG_FILTERS as FILTERS, type LogSearch } from '../lib/log-search';
import { rangeBounds, useRange } from '../lib/range';
import { currentOrg, useSession } from '../lib/session';
import { useSettings } from '../settings';

interface LogItem {
  id: string;
  createdAt: string;
  requestedModel: string;
  apiKeyId: string;
  projectId: string;
  providerId: string | null;
  modelId: string | null;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number;
  ttftMs: number | null;
  usageEstimated: boolean;
  stream: boolean;
}
interface LogDetail extends LogItem {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  attempts: unknown;
  headers?: unknown;
}
type Draft = Record<(typeof FILTERS)[number] | 'from' | 'to', string>;
const draftOf = (search: LogSearch): Draft =>
  Object.fromEntries(
    [...FILTERS, 'from', 'to'].map((key) => [key, String(search[key as keyof LogSearch] ?? '')]),
  ) as Draft;

/** Only explicit diagnostic names, never arbitrary persisted metadata or credentials. */
export function safeLogHeaders(value: unknown): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).filter(
    (entry): entry is [string, string] =>
      /^(content-type|retry-after|x-request-id|x-dirouter-request-id|x-ratelimit-(limit|remaining|reset)-(requests|tokens))$/i.test(
        entry[0],
      ) && typeof entry[1] === 'string',
  );
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, fallback: string) =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;

function FilterEditor({ search, apply }: { search: LogSearch; apply: (next: LogSearch) => void }) {
  const { t } = useTranslation();
  const s = useSettings();
  const m = logMessages[s.lang === 'fa' ? 'fa' : 'en'];
  const [draft, setDraft] = useState(() => draftOf(search));
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        const next: LogSearch = {};
        let bad = false;
        for (const key of FILTERS) {
          const value = draft[key].trim();
          if (!value) continue;
          if (key === 'minLatencyMs' || key === 'maxLatencyMs') {
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) bad = true;
            else next[key] = Number(value);
          } else if (key === 'minCostUsd' || key === 'maxCostUsd') {
            if (!/^\d{1,10}(\.\d{1,8})?$/.test(value)) bad = true;
            else next[key] = value;
          } else if (key === 'status') {
            if (value === 'success' || value === 'error') next.status = value;
          } else next[key] = value;
        }
        for (const key of ['from', 'to'] as const) {
          if (draft[key]) {
            const timestamp = Date.parse(`${draft[key]}Z`);
            if (!Number.isFinite(timestamp)) bad = true;
            else next[key] = new Date(timestamp).toISOString();
          }
        }
        for (const [min, max] of [
          [next.minLatencyMs, next.maxLatencyMs],
          [next.minCostUsd, next.maxCostUsd],
        ]) {
          if (min !== undefined && max !== undefined && Number(min) > Number(max)) bad = true;
        }
        if (
          next.from &&
          next.to &&
          (next.from >= next.to || Date.parse(next.to) - Date.parse(next.from) > 400 * 86400000)
        )
          bad = true;
        setInvalid(bad);
        if (!bad) apply(next);
      }}
    >
      {[...FILTERS, 'from', 'to'].map((field) => {
        const key = field as keyof Draft;
        const label = key === 'from' || key === 'to' ? m[key] : t(`logs.filter.${key}`);
        const props = {
          id: `log-filter-${key}`,
          className: 'rounded border border-border bg-surface px-2 py-1',
          value: draft[key],
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
            setDraft({ ...draft, [key]: event.target.value });
          },
        };
        return (
          <label key={key} className="flex flex-col gap-1 text-sm" htmlFor={props.id}>
            {label}
            {key === 'status' ? (
              <select {...props}>
                <option value="">{m.all}</option>
                <option value="success">{t('logs.status.success')}</option>
                <option value="error">{t('logs.status.error')}</option>
              </select>
            ) : (
              <input
                {...props}
                type={key === 'from' || key === 'to' ? 'datetime-local' : 'text'}
                maxLength={256}
                dir="ltr"
                step="1"
              />
            )}
          </label>
        );
      })}
      {invalid && (
        <p role="alert" className="text-danger">
          {m.invalid}
        </p>
      )}
      <Button type="submit">{m.apply}</Button>
    </form>
  );
}

function Detail({ orgId, id, close }: { orgId: string; id: string; close: () => void }) {
  const s = useSettings();
  const m = logMessages[s.lang === 'fa' ? 'fa' : 'en'];
  const query = useQuery({
    queryKey: ['log-detail', orgId, id],
    queryFn: () => api<LogDetail>(`/orgs/${orgId}/logs/${encodeURIComponent(id)}`),
  });
  const d = query.data;
  const headers = safeLogHeaders(d?.headers);
  const date = (v: unknown) =>
    typeof v === 'string' && Number.isFinite(Date.parse(v))
      ? formatDate(v, { calendar: s.calendar, lang: s.lang, time: true, seconds: true })
      : m.unavailable;
  return (
    <Card>
      <section aria-label={m.detail}>
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold">{m.detail}</h2>
          <Button variant="outline" onClick={close}>
            {m.close}
          </Button>
        </div>
        {query.isPending ? (
          <Loading />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : (
          d && (
            <>
              <dl className="grid gap-3 py-4 sm:grid-cols-3">
                {(
                  [
                    [m.request, d.id],
                    [m.key, d.apiKeyId],
                    [m.project, d.projectId],
                    [m.provider, d.providerId],
                    [m.model, d.modelId],
                    [m.status, d.httpStatus],
                    [m.reason, d.errorCode],
                    [m.input, d.inputTokens],
                    [m.output, d.outputTokens],
                    [m.cacheRead, d.cacheReadTokens],
                    [m.cacheWrite, d.cacheWriteTokens],
                    [m.reasoning, d.reasoningTokens],
                    [m.cost, d.costUsd],
                    [m.latency, d.latencyMs],
                    [m.ttft, d.ttftMs],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-muted">{label}</dt>
                    <dd dir="ltr">{text(value, m.unavailable)}</dd>
                  </div>
                ))}
              </dl>
              <p>{d.usageEstimated ? m.estimated : m.actual}</p>
              <h3 className="mt-4 font-bold">{m.timeline}</h3>
              {Array.isArray(d.attempts) && d.attempts.length ? (
                <ol className="ms-3 border-s border-border">
                  {d.attempts.map((value: unknown, index: number) => {
                    const a = record(value);
                    return (
                      <li key={index} className="p-3" data-testid="log-attempt">
                        <h4>
                          {m.attempt} {formatNumber(index + 1, s.lang)}
                        </h4>
                        <dl className="grid gap-2 sm:grid-cols-3">
                          {[
                            [m.provider, a.providerId],
                            [m.model, a.modelId],
                            [m.outcome, a.outcome],
                            [m.status, a.httpStatus],
                            [m.reason, a.errorCode ?? a.reason],
                            [m.latency, a.latencyMs],
                            [m.started, date(a.startedAt)],
                          ].map(([label, value]) => (
                            <div key={String(label)}>
                              <dt className="text-muted">{String(label)}</dt>
                              <dd dir="ltr">{text(value, m.unavailable)}</dd>
                            </div>
                          ))}
                        </dl>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <Empty title={m.noAttempts} />
              )}
              <h3 className="mt-4 font-bold">{m.headers}</h3>
              {headers.length ? (
                <dl>
                  {headers.map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd dir="ltr">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-sm text-muted">{m.noHeaders}</p>
              )}
            </>
          )
        )}
      </section>
    </Card>
  );
}

export default function LogsPage() {
  const { t } = useTranslation();
  const s = useSettings();
  useSession();
  const org = currentOrg();
  const search: LogSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const range = useRange();
  const [selected, setSelected] = useState<string | null>(null);
  const fallback = rangeBounds(range);
  const from = search.from ?? fallback.from;
  const to = search.to ?? fallback.to;
  const params = new URLSearchParams({ from, to, limit: '50' });
  for (const k of FILTERS) {
    const v = search[k];
    if (v !== undefined && v !== '') params.set(k, String(v));
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
  const apply = (next: LogSearch) => {
    setSelected(null);
    void navigate({ to: '/logs', search: next });
  };
  const clear = (k: (typeof FILTERS)[number] | 'range') => {
    apply(
      Object.fromEntries(
        Object.entries(search).filter(([key]) =>
          k === 'range' ? key !== 'from' && key !== 'to' : key !== k,
        ),
      ),
    );
  };
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">{t('logs.title')}</h1>
      <FilterEditor
        key={JSON.stringify(search)}
        search={{ ...search, from: from.slice(0, 19), to: to.slice(0, 19) }}
        apply={apply}
      />
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
        {FILTERS.filter((k) => search[k] !== undefined && search[k] !== '').map((k) => (
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
      {selected && org && (
        <Detail
          key={`${org.id}:${selected}`}
          orgId={org.id}
          id={selected}
          close={() => {
            setSelected(null);
          }}
        />
      )}
      <Card className="p-0">
        <VirtualTable
          rows={rows}
          rowKey={(r) => r.id}
          onRow={(r) => {
            setSelected(r.id);
          }}
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          columns={[
            { key: 'time', label: t('logs.col.time'), render: (r) => date(r.createdAt) },
            {
              key: 'model',
              label: t('logs.col.model'),
              render: (r) => <span dir="ltr">{r.requestedModel}</span>,
            },
            {
              key: 'status',
              label: t('logs.col.status'),
              render: (r) => (
                <span className={r.status === 'success' ? 'text-emerald-600' : 'text-danger'}>
                  {n(r.httpStatus)} {r.errorCode}
                </span>
              ),
            },
            {
              key: 'tokens',
              label: t('logs.col.tokens'),
              render: (r) => n(r.inputTokens + r.outputTokens),
            },
            {
              key: 'cost',
              label: t('logs.col.cost'),
              render: (r) => `$${Number(r.costUsd).toFixed(6)}`,
            },
            {
              key: 'latency',
              label: t('logs.col.latency'),
              render: (r) => `${n(r.latencyMs)} ${t('overview.ms')}`,
            },
          ]}
        />
      </Card>
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
