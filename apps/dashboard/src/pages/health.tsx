/**
 * Health page (card 7.8): breaker, cooldown, lockout and each credential's disabled state per provider and model,
 * and gateway nodes with their config version. Refreshes every 5 seconds. Manual reset is for OWNER and ADMIN and
 * is recorded in the audit log.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { QuotaCountdown, type QuotaWindowState } from '../components/quota-countdown';
import { PageHeader, Section, Stat } from '../components/s2/common';
import { Button } from '../components/ui/button';
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
      /** Quota windows (card 32.6); older control-api versions do not send them. */
      quotas?: QuotaWindowState[];
    }[];
  }[];
  models: { id: string; slug: string; breaker: Breaker | null }[];
}

const secondsLeft = (iso: string | null, now: number) =>
  iso ? Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000)) : 0;

const lampColor = (state: Breaker['state']) =>
  state === 'closed' ? 'bg-good' : state === 'open' ? 'bg-danger' : 'bg-warn';

function StateBadge({ breaker }: { breaker: Breaker | null }) {
  const { t } = useTranslation();
  const state = breaker?.state ?? 'closed';
  return (
    <span className="flex items-center gap-1.5 text-xs text-fg-2">
      <span aria-hidden className={`lamp ${lampColor(state)}`} />
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

  const count = (value: number) => formatNumber(value, settings.lang);
  const readyNodes = h.nodes.filter((n) => n.ready).length;
  const closedProviders = h.providers.filter((p) => (p.breaker?.state ?? 'closed') === 'closed');
  const openBreakers = h.providers.length - closedProviders.length + unhealthyModels.length;
  const credentials = h.providers.flatMap((p) => p.credentials);
  const credentialProblems = (c: (typeof credentials)[number]) =>
    [
      c.cooldownUntil && secondsLeft(c.cooldownUntil, now) > 0
        ? t('health.cooldown', { s: secondsLeft(c.cooldownUntil, now) })
        : null,
      c.disabledUntil ? t('health.disabled', { reason: c.disabledReason ?? '' }) : null,
      ...c.lockouts.map((l) =>
        t('health.lockout', { model: l.modelId, s: secondsLeft(l.until, now) }),
      ),
    ].filter((x): x is string => Boolean(x));
  const troubled = credentials.filter((c) => credentialProblems(c).length > 0).length;

  return (
    <section className="enter flex flex-col gap-6">
      <PageHeader
        title={t('health.title')}
        subtitle={
          <span data-testid="refreshed">
            {t('health.refreshing', {
              time: formatDate(now, {
                calendar: settings.calendar,
                lang: settings.lang,
                time: true,
              }),
            })}
          </span>
        }
      />
      {notice ? (
        <p role="status" className="rounded-lg bg-brand/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {!h.gatewayReachable ? (
        <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {t('health.gatewayDown')}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          size="lg"
          label={t('health.summary.nodes')}
          value={`${count(readyNodes)} / ${count(h.nodes.length)}`}
          hint={t('health.summary.nodesHint')}
        />
        <Stat
          size="lg"
          label={t('health.summary.providers')}
          value={`${count(closedProviders.length)} / ${count(h.providers.length)}`}
          hint={t('health.summary.providersHint')}
        />
        <Stat
          size="lg"
          label={t('health.summary.breakers')}
          value={count(openBreakers)}
          hint={t('health.summary.breakersHint')}
        />
        <Stat
          size="lg"
          label={t('health.summary.credentials')}
          value={`${count(troubled)} / ${count(credentials.length)}`}
          hint={t('health.summary.credentialsHint')}
        />
      </div>

      <Section title={t('health.nodes')}>
        {h.nodes.length === 0 ? (
          <p className="text-sm text-muted">{t('health.noNodes')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="py-1 text-start font-medium">{t('health.instance')}</th>
                  <th className="py-1 text-start font-medium">{t('health.configVersion')}</th>
                  <th className="py-1 text-start font-medium">{t('health.ready')}</th>
                  <th className="py-1 text-start font-medium">{t('health.lastSeen')}</th>
                </tr>
              </thead>
              <tbody>
                {h.nodes.map((n) => (
                  <tr key={n.instance} className="border-t border-border">
                    <td className="py-2 font-mono text-[13px]" dir="ltr">
                      {n.instance}
                    </td>
                    <td className="num py-2">{n.configVersion}</td>
                    <td className="py-2">
                      <span className="flex items-center gap-1.5">
                        <span aria-hidden className={`lamp ${n.ready ? 'bg-good' : 'bg-danger'}`} />
                        {n.ready ? t('health.yes') : t('health.no')}
                      </span>
                    </td>
                    <td className="py-2 text-fg-2">
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
          </div>
        )}
      </Section>

      <Section title={t('health.providers')}>
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {h.providers.map((p) => (
            <li
              key={p.id}
              className="rounded-lg border border-border p-4"
              data-testid={`provider-${p.slug}`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{p.name}</span>
                <StateBadge breaker={p.breaker} />
                <span className="ms-auto">
                  {p.breaker && p.breaker.state !== 'closed' ? resetButton('provider', p.id) : null}
                </span>
              </div>
              {p.breaker && (p.breaker.total > 0 || p.breaker.reopensAt) ? (
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
                  {p.breaker.total > 0 ? (
                    <span>
                      {t('health.errors', { errors: p.breaker.errors, total: p.breaker.total })}
                    </span>
                  ) : null}
                  {p.breaker.reopensAt ? (
                    <span>
                      {t('health.reopensIn', { s: secondsLeft(p.breaker.reopensAt, now) })}
                    </span>
                  ) : null}
                </p>
              ) : null}
              <ul className="mt-3 flex flex-col gap-2 border-t border-border pt-3 text-[13px]">
                {p.credentials.map((c) => {
                  const problems = credentialProblems(c);
                  return (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center gap-2"
                      data-testid={`credential-${c.name}`}
                    >
                      <span className="font-mono text-fg-2" dir="ltr">
                        {c.name}
                      </span>
                      <span className={problems.length ? 'text-warn' : 'text-muted'}>
                        {problems.length ? problems.join(' · ') : t('health.healthy')}
                      </span>
                      <span className="ms-auto">
                        {problems.length ? resetButton('credential', c.id) : null}
                      </span>
                      <QuotaCountdown quotas={c.quotas ?? []} lang={settings.lang} />
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t('health.models')}>
        {unhealthyModels.length === 0 ? (
          <p className="text-sm text-muted">{t('health.allClosed')}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {unhealthyModels.map((m) => (
              <li key={m.id} className="flex items-center gap-3">
                <span className="font-mono text-[13px]" dir="ltr">
                  {m.slug}
                </span>
                <StateBadge breaker={m.breaker} />
                <span className="ms-auto">{resetButton('model', m.id)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </section>
  );
}
