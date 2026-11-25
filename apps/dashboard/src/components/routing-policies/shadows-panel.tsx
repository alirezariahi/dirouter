/**
 * Shadow traffic (card 32.4): policies with the shadow-versus-primary comparison of errors,
 * latency and cost, today's shadow spend against its cap, and a form for new policies.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Section } from '../s2/common';
import { Button } from '../ui/button';
import { Field, FormError } from '../ui/field';
import { Loading } from '../ui/states';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { formatUsd, listOf, useFormat } from '../../lib/s2-format';

interface Shadow {
  id: string;
  name: string;
  enabled: boolean;
  match: string;
  target: string;
  sampleRate: number;
  dailyBudgetUsd: string;
}
interface Side {
  errors: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  costUsd: string;
}
interface Report {
  requests: number;
  shadow: Side & { model: string };
  primary: Side;
  today: { spentUsd: string; dailyBudgetUsd: string; capped: boolean };
}

function ShadowCard({
  policy,
  base,
  canWrite,
}: {
  policy: Shadow;
  base: string;
  canWrite: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { n } = useFormat();
  const lang = i18n.language === 'fa' ? 'fa' : 'en';
  const qc = useQueryClient();
  const url = `${base}/routing/shadows/${policy.id}`;
  const report = useQuery({
    queryKey: ['shadow-report', policy.id],
    queryFn: () => api<Report>(`${url}/report`),
  });
  const done = () => qc.invalidateQueries({ queryKey: ['routing-shadows', base] });
  const toggle = useMutation({
    mutationFn: () => api<unknown>(url, { method: 'PATCH', body: { enabled: !policy.enabled } }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api<unknown>(url, { method: 'DELETE' }),
    onSuccess: done,
  });
  const ms = (v: number | null) => (v === null ? '—' : `${n(v)} ms`);
  const r = report.data;
  const row = (name: 'primary' | 'shadow', side: Side | undefined) =>
    side ? (
      <tr key={name} className="border-t border-border" data-testid={`shadow-${name}`}>
        <td className="py-1.5">{t(`routingPolicies.shadows.${name}`)}</td>
        <td className="py-1.5">{n(side.errors)}</td>
        <td className="py-1.5">
          {ms(side.avgLatencyMs)} / {ms(side.p95LatencyMs)}
        </td>
        <td className="py-1.5">{formatUsd(side.costUsd, lang)}</td>
      </tr>
    ) : null;

  return (
    <li className="flex flex-col gap-2 rounded border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">
            {policy.name}{' '}
            <span className="text-xs text-muted">
              {policy.enabled
                ? t('routingPolicies.shadows.enabled')
                : t('routingPolicies.shadows.disabled')}
            </span>
          </p>
          <p className="text-xs text-muted">
            <bdi dir="ltr">{policy.match}</bdi> → <bdi dir="ltr">{policy.target}</bdi> (
            {n(Math.round(policy.sampleRate * 1000) / 10)}%)
          </p>
        </div>
        {canWrite ? (
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={toggle.isPending}
              onClick={() => {
                toggle.mutate();
              }}
            >
              {policy.enabled
                ? t('routingPolicies.shadows.disable')
                : t('routingPolicies.shadows.enable')}
            </Button>
            <Button
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              {t('routingPolicies.shadows.delete')}
            </Button>
          </div>
        ) : null}
      </div>
      {r ? (
        <>
          <p className="text-xs text-muted">
            {t('routingPolicies.shadows.report', { count: r.requests })}
          </p>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted">
                <th className="py-1 text-start font-medium">{t('routingPolicies.shadows.side')}</th>
                <th className="py-1 text-start font-medium">
                  {t('routingPolicies.shadows.errors')}
                </th>
                <th className="py-1 text-start font-medium">
                  {t('routingPolicies.shadows.latency')}
                </th>
                <th className="py-1 text-start font-medium">{t('routingPolicies.shadows.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {row('primary', r.primary)}
              {row('shadow', r.shadow)}
            </tbody>
          </table>
          <p className="text-xs text-muted" data-testid={`shadow-today-${policy.id}`}>
            {t('routingPolicies.shadows.today', {
              spent: formatUsd(r.today.spentUsd, lang),
              cap: formatUsd(r.today.dailyBudgetUsd, lang),
            })}
          </p>
          {r.today.capped ? (
            <p className="text-xs text-danger">{t('routingPolicies.shadows.capped')}</p>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

const EMPTY = { name: '', match: '', target: '', percent: '10', budget: '5' };

export function ShadowsPanel({ base, canWrite }: { base: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(EMPTY);
  const shadows = useQuery({
    queryKey: ['routing-shadows', base],
    queryFn: () => api<unknown>(`${base}/routing/shadows`),
  });
  const create = useMutation({
    mutationFn: () =>
      api<unknown>(`${base}/routing/shadows`, {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          match: draft.match.trim(),
          target: draft.target.trim(),
          sampleRate: Number(draft.percent) / 100,
          dailyBudgetUsd: draft.budget.trim(),
        },
      }),
    onSuccess: () => {
      setDraft(EMPTY);
      void qc.invalidateQueries({ queryKey: ['routing-shadows', base] });
    },
  });
  const set = (key: keyof typeof EMPTY, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const list = listOf<Shadow>(shadows.data);
  const fields: { key: keyof typeof EMPTY; label: string; type?: string }[] = [
    { key: 'name', label: t('routingPolicies.shadows.name') },
    { key: 'match', label: t('routingPolicies.shadows.match') },
    { key: 'target', label: t('routingPolicies.shadows.target') },
    { key: 'percent', label: t('routingPolicies.shadows.sampleRate'), type: 'number' },
    { key: 'budget', label: t('routingPolicies.shadows.dailyBudget') },
  ];

  return (
    <>
      <FormError message={create.error ? errorMessage(create.error, t) : undefined} />
      <Section title={t('routingPolicies.tabs.shadows')} help={t('routingPolicies.shadows.help')}>
        {shadows.isPending ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">{t('routingPolicies.shadows.none')}</p>
        ) : (
          <ul data-testid="shadow-policies" className="flex flex-col gap-3">
            {list.map((policy) => (
              <ShadowCard key={policy.id} policy={policy} base={base} canWrite={canWrite} />
            ))}
          </ul>
        )}
      </Section>
      {canWrite ? (
        <Section title={t('routingPolicies.shadows.newTitle')}>
          <form
            className="grid gap-3 md:grid-cols-3"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            {fields.map((f) => (
              <Field
                key={f.key}
                name={`shadow-${f.key}`}
                label={f.label}
                required
                dir={f.key === 'name' ? undefined : 'ltr'}
                {...(f.type ? { type: f.type, min: 0, max: 100, step: 0.1 } : {})}
                value={draft[f.key]}
                onChange={(e) => {
                  set(f.key, e.target.value);
                }}
              />
            ))}
            <div className="flex items-end">
              <Button type="submit" disabled={create.isPending}>
                {t('routingPolicies.shadows.create')}
              </Button>
            </div>
          </form>
        </Section>
      ) : null}
    </>
  );
}
