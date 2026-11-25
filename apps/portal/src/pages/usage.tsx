/**
 * The workspace's usage (card 26.2): cost and tokens per day, by model and by key, and the latest
 * requests with what each one cost. Figures come from `GET /orgs/{org}/usage`, which reads the
 * wallet's usage debits (prepaid) or the request log's prices (postpaid), so they match the
 * statement and the invoices.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../lib/api';
import { count, date, day, usd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { orgId } from '../lib/session';
import { Button, Card, Mono, Notice } from '../lib/ui';

interface Bucket {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
}
export interface Usage {
  from: string;
  to: string;
  basis: 'prepaid' | 'postpaid';
  totals: Bucket;
  byDay: (Bucket & { day: string })[];
  byModel: (Bucket & { model: string })[];
  byKey: (Bucket & { apiKeyId: string | null; name: string | null; prefix: string | null })[];
  recent: {
    requestId: string;
    createdAt: string;
    model: string;
    keyName: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: string;
  }[];
}

const RANGES = [7, 30, 90] as const;
const DAY_MS = 86_400_000;

/** [from, to) in UTC days, ending today. */
function range(days: number, now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: iso(end - days * DAY_MS), to: iso(end) };
}

/** Relative size of a decimal string, for bar heights only (never for amounts shown). */
const magnitude = (v: string) => Number(v);

function Bars({
  label,
  days,
  value,
  show,
}: {
  label: string;
  days: Usage['byDay'];
  value: (d: Usage['byDay'][number]) => number;
  show: (d: Usage['byDay'][number]) => string;
}) {
  const { lang } = useI18n();
  const max = Math.max(...days.map(value), 0);
  return (
    <figure aria-label={label}>
      <div className="flex h-32 items-end gap-px" dir="ltr">
        {days.map((d) => (
          <div
            key={d.day}
            className="flex-1 rounded-t-sm bg-teal-600/80 hover:bg-teal-700"
            style={{
              height: `${String(max > 0 ? Math.max((value(d) / max) * 100, value(d) > 0 ? 2 : 0) : 0)}%`,
            }}
            title={`${day(d.day, lang)}: ${show(d)}`}
          />
        ))}
      </div>
      <figcaption className="mt-1 flex justify-between text-xs text-stone-500" dir="ltr">
        <span>{days[0] ? day(days[0].day, lang) : ''}</span>
        <span>{days.at(-1) ? day(days.at(-1)?.day ?? '', lang) : ''}</span>
      </figcaption>
    </figure>
  );
}

function Breakdown({ rows }: { rows: { label: string; mono?: boolean; bucket: Bucket }[] }) {
  const { t, lang } = useI18n();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-stone-500">
          <tr className="border-b border-stone-200">
            <th className="py-2 text-start font-medium" />
            <th className="py-2 text-start font-medium">{t.requests}</th>
            <th className="py-2 text-start font-medium">{t.inputTokens}</th>
            <th className="py-2 text-start font-medium">{t.outputTokens}</th>
            <th className="py-2 text-start font-medium">{t.cost}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-stone-100 last:border-0">
              <td className="py-2">{r.mono ? <Mono>{r.label}</Mono> : r.label}</td>
              <td className="py-2">{count(r.bucket.requests, lang)}</td>
              <td className="py-2">{count(r.bucket.inputTokens, lang)}</td>
              <td className="py-2">{count(r.bucket.outputTokens, lang)}</td>
              <td className="py-2">
                <Mono>{usd(r.bucket.costUsd)}</Mono>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsagePage() {
  const { t, lang } = useI18n();
  const org = orgId();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const { from, to } = range(days);
  const usage = useQuery({
    queryKey: ['usage', org, from, to],
    queryFn: () => api<Usage>(`/orgs/${org}/usage?from=${from}&to=${to}`),
  });
  const u = usage.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-stone-900">{t.usage}</h1>
        <div className="flex gap-2">
          {RANGES.map((n) => (
            <Button
              key={n}
              variant={n === days ? 'primary' : 'quiet'}
              aria-pressed={n === days}
              onClick={() => {
                setDays(n);
              }}
            >
              {count(n, lang)} {t.lastDays}
            </Button>
          ))}
        </div>
      </div>
      {usage.error && <Notice tone="error">{usage.error.message}</Notice>}
      {u && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            {(
              [
                [t.cost, <Mono key="c">{usd(u.totals.costUsd)}</Mono>],
                [t.requests, count(u.totals.requests, lang)],
                [t.inputTokens, count(u.totals.inputTokens, lang)],
                [t.outputTokens, count(u.totals.outputTokens, lang)],
              ] as const
            ).map(([label, value]) => (
              <Card key={label}>
                <p className="text-sm text-stone-500">{label}</p>
                <p
                  className="mt-1 text-2xl font-semibold text-stone-900"
                  data-testid={`total-${label}`}
                >
                  {value}
                </p>
              </Card>
            ))}
          </div>
          <Notice>{u.basis === 'prepaid' ? t.prepaidNote : t.postpaidNote}</Notice>
          {u.totals.requests === 0 ? (
            <Notice>{t.noUsage}</Notice>
          ) : (
            <>
              <div className="grid gap-6 lg:grid-cols-2">
                <Card title={t.costPerDay}>
                  <Bars
                    label={t.costPerDay}
                    days={u.byDay}
                    value={(d) => magnitude(d.costUsd)}
                    show={(d) => usd(d.costUsd)}
                  />
                </Card>
                <Card title={t.tokensPerDay}>
                  <Bars
                    label={t.tokensPerDay}
                    days={u.byDay}
                    value={(d) => d.inputTokens + d.outputTokens}
                    show={(d) => count(d.inputTokens + d.outputTokens, lang)}
                  />
                </Card>
              </div>
              <Card title={t.byModel}>
                <Breakdown
                  rows={u.byModel.map((m) => ({ label: m.model, mono: true, bucket: m }))}
                />
              </Card>
              <Card title={t.byKey}>
                <Breakdown
                  rows={u.byKey.map((k) => ({
                    label: k.name ?? k.apiKeyId ?? '—',
                    bucket: k,
                  }))}
                />
              </Card>
              <Card title={t.recentRequests}>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-stone-500">
                      <tr className="border-b border-stone-200">
                        <th className="py-2 text-start font-medium">{t.date}</th>
                        <th className="py-2 text-start font-medium">{t.model}</th>
                        <th className="py-2 text-start font-medium">{t.key}</th>
                        <th className="py-2 text-start font-medium">{t.inputTokens}</th>
                        <th className="py-2 text-start font-medium">{t.outputTokens}</th>
                        <th className="py-2 text-start font-medium">{t.cost}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {u.recent.map((r) => (
                        <tr key={r.requestId} className="border-b border-stone-100 last:border-0">
                          <td className="py-2 text-stone-600">{date(r.createdAt, lang)}</td>
                          <td className="py-2">
                            <Mono>{r.model}</Mono>
                          </td>
                          <td className="py-2">{r.keyName ?? '—'}</td>
                          <td className="py-2">
                            {r.inputTokens === null ? '—' : count(r.inputTokens, lang)}
                          </td>
                          <td className="py-2">
                            {r.outputTokens === null ? '—' : count(r.outputTokens, lang)}
                          </td>
                          <td className="py-2">
                            <Mono>{usd(r.costUsd)}</Mono>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
