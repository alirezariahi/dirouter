/**
 * صفحهٔ Health (کارت ۷.۸): breaker هر provider و مدل، cooldown، lockout و غیرفعالی هر credential،
 * و نودهای گیت‌وی با نسخهٔ config. هر ۵ ثانیه تازه می‌شود. ریست دستی برای OWNER و ADMIN است و
 * در audit log ثبت می‌شود.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate, formatNumber } from '../lib/date';
import { errorMessage } from '../lib/errors';
import { currentOrg, useSession } from '../lib/session';
import { useSettings } from '../settings';

interface Breaker {
  state: 'closed' | 'open' | 'half_open';
  total: number;
  errors: number;
  reopensAt: string | null;
}
interface RuntimeHealth {
  gatewayReachable: boolean;
  nodes: { instance: string; configVersion: number; ready: boolean; lastSeen: string }[];
  providers: {
    id: string;
    name: string;
    slug: string;
    breaker: Breaker | null;
    credentials: {
      id: string;
      name: string;
      cooldownUntil: string | null;
      disabledUntil: string | null;
      disabledReason: string | null;
      lockouts: { modelId: string; until: string | null }[];
    }[];
  }[];
  models: { id: string; slug: string; breaker: Breaker | null }[];
}

const secondsLeft = (iso: string | null, now: number) =>
  iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : 0;

function StateBadge({ breaker }: { breaker: Breaker | null }) {
  const { t } = useTranslation();
  const state = breaker?.state ?? 'closed';
  const color =
    state === 'closed'
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : state === 'open'
        ? 'bg-danger/15 text-danger'
        : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {t(`health.state.${state}`)}
    </span>
  );
}

export default function HealthPage() {
  const { t } = useTranslation();
  const settings = useSettings();
  const user = useSession();
  const org = currentOrg();
  const role = user?.organizations.find((o) => o.id === org?.id)?.role;
  const canReset = role === 'OWNER' || role === 'ADMIN';
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string>();

  const query = useQuery({
    queryKey: ['health', org?.id],
    queryFn: () => api<RuntimeHealth>(`/orgs/${org?.id ?? ''}/health/runtime`),
    refetchInterval: 5_000,
    enabled: Boolean(org),
  });
  const reset = useMutation({
    mutationFn: (target: { scope: 'provider' | 'model' | 'credential'; id: string }) =>
      api<{ gatewaysNotified: number }>(`/orgs/${org?.id ?? ''}/health/reset`, {
        method: 'POST',
        body: target,
      }),
    onSuccess: (r) => {
      setNotice(t('health.resetDone', { n: formatNumber(r.gatewaysNotified, settings.lang) }));
      void qc.invalidateQueries({ queryKey: ['health'] });
    },
    onError: (e) => {
      setNotice(errorMessage(e, t));
    },
  });

  if (query.isPending) return <Loading />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const h = query.data;
  const now = query.dataUpdatedAt;
  const resetButton = (scope: 'provider' | 'model' | 'credential', id: string) =>
    canReset ? (
      <Button
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={reset.isPending}
        onClick={() => {
          reset.mutate({ scope, id });
        }}
      >
        {t('health.reset')}
      </Button>
    ) : null;
  const unhealthyModels = h.models.filter((m) => m.breaker && m.breaker.state !== 'closed');

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-bold">{t('health.title')}</h1>
        <p className="text-xs text-muted" data-testid="refreshed">
          {t('health.refreshing', {
            time: formatDate(now, { calendar: settings.calendar, lang: settings.lang, time: true }),
          })}
        </p>
      </div>
      {notice ? (
        <p role="status" className="rounded-md bg-brand/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {!h.gatewayReachable ? (
        <p className="text-sm text-danger">{t('health.gatewayDown')}</p>
      ) : null}

      <Card>
        <h2 className="mb-3 font-medium">{t('health.nodes')}</h2>
        {h.nodes.length === 0 ? (
          <p className="text-sm text-muted">{t('health.noNodes')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-start text-muted">
              <tr>
                <th className="py-1 text-start font-normal">{t('health.instance')}</th>
                <th className="py-1 text-start font-normal">{t('health.configVersion')}</th>
                <th className="py-1 text-start font-normal">{t('health.ready')}</th>
                <th className="py-1 text-start font-normal">{t('health.lastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {h.nodes.map((n) => (
                <tr key={n.instance} className="border-t border-border">
                  <td className="py-1.5" dir="ltr">
                    {n.instance}
                  </td>
                  <td className="py-1.5">{n.configVersion}</td>
                  <td className="py-1.5">{n.ready ? t('health.yes') : t('health.no')}</td>
                  <td className="py-1.5">
                    {formatDate(n.lastSeen, {
                      calendar: settings.calendar,
                      lang: settings.lang,
                      time: true,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">{t('health.providers')}</h2>
        <ul className="flex flex-col gap-3">
          {h.providers.map((p) => (
            <li
              key={p.id}
              className="rounded-md border border-border p-3"
              data-testid={`provider-${p.slug}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <StateBadge breaker={p.breaker} />
                {p.breaker && p.breaker.total > 0 ? (
                  <span className="text-xs text-muted">
                    {t('health.errors', { errors: p.breaker.errors, total: p.breaker.total })}
                  </span>
                ) : null}
                {p.breaker?.reopensAt ? (
                  <span className="text-xs text-muted">
                    {t('health.reopensIn', { s: secondsLeft(p.breaker.reopensAt, now) })}
                  </span>
                ) : null}
                <span className="ms-auto">
                  {p.breaker && p.breaker.state !== 'closed' ? resetButton('provider', p.id) : null}
                </span>
              </div>
              <ul className="mt-2 flex flex-col gap-1 ps-3 text-sm">
                {p.credentials.map((c) => {
                  const problems = [
                    c.cooldownUntil && secondsLeft(c.cooldownUntil, now) > 0
                      ? t('health.cooldown', { s: secondsLeft(c.cooldownUntil, now) })
                      : null,
                    c.disabledUntil
                      ? t('health.disabled', { reason: c.disabledReason ?? '' })
                      : null,
                    ...c.lockouts.map((l) =>
                      t('health.lockout', { model: l.modelId, s: secondsLeft(l.until, now) }),
                    ),
                  ].filter(Boolean);
                  return (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-2"
                      data-testid={`credential-${c.name}`}
                    >
                      <span>{c.name}</span>
                      <span
                        className={
                          problems.length ? 'text-amber-700 dark:text-amber-300' : 'text-muted'
                        }
                      >
                        {problems.length ? problems.join(' · ') : t('health.healthy')}
                      </span>
                      <span className="ms-auto">
                        {problems.length ? resetButton('credential', c.id) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="mb-3 font-medium">{t('health.models')}</h2>
        {unhealthyModels.length === 0 ? (
          <p className="text-sm text-muted">{t('health.allClosed')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {unhealthyModels.map((m) => (
              <li key={m.id} className="flex items-center gap-2">
                <span dir="ltr">{m.slug}</span>
                <StateBadge breaker={m.breaker} />
                <span className="ms-auto">{resetButton('model', m.id)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
