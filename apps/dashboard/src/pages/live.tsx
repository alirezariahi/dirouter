/**
 * Live view (cards 16.3 and 24.4): requests of the last 15 minutes plus provider breaker state.
 * New requests arrive over Server-Sent Events as soon as the gateway finishes them; while the
 * stream is down the page polls every second and keeps trying to reconnect. Both carry request
 * metadata only (model, status, latency, tokens, cost); prompt and response content never reach
 * this page.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PageHeader, Section, Stat } from '../components/s2/common';
import { Button } from '../components/ui/button';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { listOf, useFormat } from '../lib/s2-format';
import { formatDate } from '../lib/date';
import { currentOrg } from '../lib/session';
import { LIVE_REFRESH_MS, liveCounts, median } from '../lib/s2-helpers';
import { connectLive, type LiveRow, mergeLive } from '../lib/live-stream';
import { liveMessages } from '../i18n/live-messages';
import { useSettings } from '../settings';

/** With the stream up, a slow poll still refreshes breaker state and catches anything missed. */
const LIVE_STREAM_POLL_MS = 15_000;
/** Reconnect delays after the stream drops (the page polls meanwhile). */
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface LiveItem {
  id: string;
  createdAt: string;
  requestedModel: string;
  providerId: string | null;
  status: string;
  httpStatus: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number;
  stream: boolean;
}
interface LiveData {
  generatedAt: string;
  recent: unknown;
  health: { providers: { id: string; name: string; breaker: { state: string } | null }[] };
}

export default function LivePage() {
  const { t } = useTranslation();
  const { n, usd, settings } = useFormat();
  const org = currentOrg();
  const [paused, setPaused] = useState(false);
  const lm = liveMessages[useSettings().lang];
  const [mode, setMode] = useState<'connecting' | 'stream' | 'polling'>('connecting');
  const [pushed, setPushed] = useState<LiveRow[]>([]);
  // The stream keeps the page current between polls, so counts are relative to a ticking clock.
  const [clock, setClock] = useState(() => Date.now());
  const orgId = org?.id;
  useEffect(() => {
    if (!orgId || paused) return;
    const stop = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      void connectLive(
        orgId,
        {
          onOpen: () => {
            attempt = 0;
            setMode('stream');
          },
          onEvent: (row) => {
            const now = Date.now();
            setClock(now);
            setPushed((rows) => mergeLive([], [row, ...rows], now));
          },
          onDrop: () => {
            // Poll every second until the stream is back.
            setMode('polling');
            timer = setTimeout(open, RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]);
            attempt += 1;
          },
        },
        stop.signal,
      );
    };
    open();
    const tick = setInterval(() => {
      setClock(Date.now());
    }, 1_000);
    return () => {
      stop.abort();
      clearInterval(tick);
      if (timer) clearTimeout(timer);
    };
  }, [orgId, paused]);
  const query = useQuery({
    queryKey: ['live', org?.id],
    queryFn: () => api<LiveData>(`/orgs/${org?.id ?? ''}/stats/live`),
    enabled: Boolean(org),
    refetchInterval: paused ? false : mode === 'stream' ? LIVE_STREAM_POLL_MS : LIVE_REFRESH_MS,
    // No polling while the tab is hidden; react-query refetches once when it becomes visible again.
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !paused,
  });
  if (query.isError && !query.data)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Loading />;
  const data = query.data;
  const streaming = mode === 'stream' && !paused;
  const generated = streaming ? clock : Date.parse(data.generatedAt);
  const items: LiveItem[] = mergeLive(listOf<LiveItem>(data.recent), pushed, generated);
  // The endpoint returns the latest rows only (no server-side counters), so both numbers are
  // counts within that sample and are labelled as such.
  const counts = liveCounts(items, generated);
  const open = data.health.providers.filter((p) => p.breaker && p.breaker.state !== 'closed');
  const newest = items[0];
  const delayMs = newest
    ? Math.max(0, generated - Date.parse(newest.createdAt) - newest.latencyMs)
    : undefined;
  const time = (iso: string) =>
    formatDate(iso, {
      calendar: settings.calendar,
      lang: settings.lang,
      time: true,
      seconds: true,
    });

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader title={t('s2.live.title')} subtitle={t('s2.live.subtitle')}>
        <div className="flex items-center gap-2">
          <span
            className="text-xs text-muted"
            data-testid="live-mode"
            data-mode={paused ? 'paused' : mode}
          >
            {paused ? lm.paused : lm[mode]}
          </span>
          <span className="text-xs text-muted">
            {t('s2.live.updated', { time: time(data.generatedAt) })}
          </span>
          <Button
            variant="outline"
            aria-pressed={paused}
            onClick={() => {
              setPaused((value) => !value);
            }}
          >
            {paused ? t('s2.live.resume') : t('s2.live.pause')}
          </Button>
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label={t('s2.live.perMinute')}
          value={`${n(counts.lastMinute)}${counts.saturated ? '+' : ''}`}
          hint={
            counts.saturated
              ? t('s2.live.perMinuteCapped', { n: n(counts.sample) })
              : t('s2.live.sampleHint', { n: n(counts.sample) })
          }
        />
        <Stat label={t('s2.live.errors', { n: n(counts.sample) })} value={n(counts.errors)} />
        <Stat
          label={t('s2.live.p50')}
          value={`${n(Math.round(median(items.map((item) => item.latencyMs))))} ${t('overview.ms')}`}
        />
        <Stat
          label={t('s2.live.open')}
          value={n(open.length)}
          {...(open.length ? { hint: open.map((p) => p.name).join('، ') } : {})}
        />
      </div>

      <Section title={t('s2.live.title')}>
        {items.length === 0 ? (
          <p className="text-sm text-muted">{t('s2.common.none')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table data-testid="live-table" className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  <th className="py-2.5 text-start font-medium">{t('s2.live.time')}</th>
                  <th className="py-2.5 text-start font-medium">{t('s2.live.model')}</th>
                  <th className="py-2.5 text-start font-medium">{t('s2.live.status')}</th>
                  <th className="py-2.5 text-end font-medium">{t('s2.live.latency')}</th>
                  <th className="py-2.5 text-end font-medium">{t('s2.live.tokens')}</th>
                  <th className="py-2.5 text-end font-medium">{t('s2.live.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-border transition-colors duration-150 last:border-0 hover:bg-surface-2/60"
                  >
                    <td className="num py-2.5 whitespace-nowrap text-fg-2">
                      {time(item.createdAt)}
                    </td>
                    <td className="py-2.5 font-mono text-[13px]" dir="ltr">
                      {item.requestedModel}
                      {item.stream ? (
                        <span className="ms-2 text-xs text-muted">{t('s2.live.stream')}</span>
                      ) : null}
                    </td>
                    <td className="num py-2.5">
                      {item.status === 'success' ? (
                        <span className="inline-flex items-center gap-2">
                          <span aria-hidden className="lamp text-good" />
                          {t('s2.live.ok')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2 text-danger">
                          <span aria-hidden className="lamp" />
                          <bdi dir="ltr">{item.errorCode ?? String(item.httpStatus)}</bdi>
                        </span>
                      )}
                    </td>
                    <td className="num py-2.5 text-end">{n(item.latencyMs)}</td>
                    <td className="num py-2.5 text-end">
                      {n(item.inputTokens + item.outputTokens)}
                    </td>
                    <td className="num py-2.5 text-end">{usd(item.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {delayMs !== undefined ? (
          <p className="text-xs text-muted">
            {t('s2.live.delay')}: {n(Math.round(delayMs))} {t('overview.ms')}
          </p>
        ) : null}
      </Section>
    </section>
  );
}
