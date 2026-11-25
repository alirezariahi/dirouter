/**
 * Canary and percentage traffic splits (card 32.3): each split with its version and state, the
 * stable-versus-canary comparison, instant rollback, the version history with restore, and a form
 * for new splits.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Section, selectClass } from '../s2/common';
import { Button } from '../ui/button';
import { Field, FormError } from '../ui/field';
import { Loading } from '../ui/states';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { formatUsd, listOf, useFormat } from '../../lib/s2-format';

interface Split {
  id: string;
  version: number;
  name: string;
  match: string;
  stable: string;
  canary: string;
  canaryPercent: number;
  stickiness: 'key' | 'session' | 'request';
  autoRollback: { enabled: boolean; errorRate: number } | null;
  state: 'active' | 'rolled_back';
}
interface Branch {
  model: string;
  requests: number;
  errorRate: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  costUsd: string;
  avgCostUsd: string;
}
interface Report {
  stable: Branch;
  canary: Branch;
}
interface Version {
  version: number;
  reason: string;
  createdAt: string;
  config: { canaryPercent?: number; canary?: string; state?: string };
}

function SplitCard({ split, base, canWrite }: { split: Split; base: string; canWrite: boolean }) {
  const { t, i18n } = useTranslation();
  const { n } = useFormat();
  const lang = i18n.language === 'fa' ? 'fa' : 'en';
  const qc = useQueryClient();
  const [showVersions, setShowVersions] = useState(false);
  const url = `${base}/routing/splits/${split.id}`;
  const report = useQuery({
    queryKey: ['split-report', split.id, split.version],
    queryFn: () => api<Report>(`${url}/report`),
  });
  const versions = useQuery({
    queryKey: ['split-versions', split.id, split.version],
    queryFn: () => api<Version[]>(`${url}/versions`),
    enabled: showVersions,
  });
  const done = () => qc.invalidateQueries({ queryKey: ['routing-splits', base] });
  const rollback = useMutation({
    mutationFn: (toVersion?: number) =>
      api<unknown>(`${url}/rollback`, {
        method: 'POST',
        body: toVersion === undefined ? {} : { toVersion },
      }),
    onSuccess: done,
  });
  const resume = useMutation({
    mutationFn: () => api<unknown>(url, { method: 'PATCH', body: { state: 'active' } }),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api<unknown>(url, { method: 'DELETE' }),
    onSuccess: done,
  });
  const ms = (v: number | null) => (v === null ? '—' : `${n(v)} ms`);
  const row = (name: 'stable' | 'canary', b: Branch | undefined) =>
    b ? (
      <tr key={name} className="border-t border-border" data-testid={`split-${name}`}>
        <td className="py-1.5">
          {t(`routingPolicies.splits.${name}`)} · <bdi dir="ltr">{b.model}</bdi>
        </td>
        <td className="py-1.5">{n(b.requests)}</td>
        <td className="py-1.5">{`${n(Math.round(b.errorRate * 1000) / 10)}%`}</td>
        <td className="py-1.5">
          {ms(b.avgLatencyMs)} / {ms(b.p95LatencyMs)}
        </td>
        <td className="py-1.5">
          {formatUsd(b.costUsd, lang)} / {formatUsd(b.avgCostUsd, lang)}
        </td>
      </tr>
    ) : null;

  return (
    <li className="flex flex-col gap-2 rounded border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">
            {split.name}{' '}
            <span className="text-xs text-muted">
              {t('routingPolicies.splits.version', { version: n(split.version) })} ·{' '}
              <span data-testid={`split-state-${split.id}`}>
                {t(`routingPolicies.splits.states.${split.state}`)}
              </span>
            </span>
          </p>
          <p className="text-xs text-muted">
            <bdi dir="ltr">{split.match}</bdi> → <bdi dir="ltr">{split.stable}</bdi> /{' '}
            <bdi dir="ltr">{split.canary}</bdi> ({n(split.canaryPercent)}%) ·{' '}
            {t(`routingPolicies.splits.stickinessOptions.${split.stickiness}`)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => {
              setShowVersions((v) => !v);
            }}
          >
            {t('routingPolicies.splits.versions')}
          </Button>
          {canWrite ? (
            <>
              {split.state === 'active' ? (
                <Button
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={rollback.isPending}
                  onClick={() => {
                    rollback.mutate(undefined);
                  }}
                >
                  {t('routingPolicies.splits.rollback')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={resume.isPending}
                  onClick={() => {
                    resume.mutate();
                  }}
                >
                  {t('routingPolicies.splits.resume')}
                </Button>
              )}
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate();
                }}
              >
                {t('routingPolicies.splits.delete')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
      <FormError
        message={
          (rollback.error ?? resume.error ?? remove.error)
            ? errorMessage(rollback.error ?? resume.error ?? remove.error, t)
            : undefined
        }
      />
      <p className="text-xs text-muted">{t('routingPolicies.splits.report')}</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted">
            <th className="py-1 text-start font-medium">{t('routingPolicies.splits.branch')}</th>
            <th className="py-1 text-start font-medium">{t('routingPolicies.splits.requests')}</th>
            <th className="py-1 text-start font-medium">{t('routingPolicies.splits.errors')}</th>
            <th className="py-1 text-start font-medium">{t('routingPolicies.splits.latency')}</th>
            <th className="py-1 text-start font-medium">{t('routingPolicies.splits.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {row('stable', report.data?.stable)}
          {row('canary', report.data?.canary)}
        </tbody>
      </table>
      {showVersions ? (
        <ol className="flex flex-col gap-1 text-xs" data-testid={`split-versions-${split.id}`}>
          {(versions.data ?? []).map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2">
              <span>{t('routingPolicies.splits.version', { version: n(v.version) })}</span>
              <span className="text-muted">
                {t(`routingPolicies.splits.reasons.${v.reason}`, { defaultValue: v.reason })}
              </span>
              <span className="text-muted">
                <bdi dir="ltr">{v.config.canary}</bdi> {n(v.config.canaryPercent ?? 0)}%
              </span>
              {canWrite && v.version !== split.version ? (
                <Button
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    rollback.mutate(v.version);
                  }}
                >
                  {t('routingPolicies.splits.restore')}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

const EMPTY = {
  name: '',
  match: '',
  stable: '',
  canary: '',
  percent: '5',
  stickiness: 'key',
  rollbackAt: '20',
};

export function SplitsPanel({ base, canWrite }: { base: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(EMPTY);
  const splits = useQuery({
    queryKey: ['routing-splits', base],
    queryFn: () => api<unknown>(`${base}/routing/splits`),
  });
  const create = useMutation({
    mutationFn: () =>
      api<unknown>(`${base}/routing/splits`, {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          match: draft.match.trim(),
          stable: draft.stable.trim(),
          canary: draft.canary.trim(),
          canaryPercent: Number(draft.percent),
          stickiness: draft.stickiness,
          autoRollback: draft.rollbackAt
            ? { enabled: true, errorRate: Number(draft.rollbackAt) / 100 }
            : null,
        },
      }),
    onSuccess: () => {
      setDraft(EMPTY);
      void qc.invalidateQueries({ queryKey: ['routing-splits', base] });
    },
  });
  const set = (key: keyof typeof EMPTY, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const list = listOf<Split>(splits.data);

  return (
    <>
      <FormError message={create.error ? errorMessage(create.error, t) : undefined} />
      <Section title={t('routingPolicies.tabs.splits')} help={t('routingPolicies.splits.help')}>
        {splits.isPending ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">{t('routingPolicies.splits.none')}</p>
        ) : (
          <ul data-testid="traffic-splits" className="flex flex-col gap-3">
            {list.map((split) => (
              <SplitCard key={split.id} split={split} base={base} canWrite={canWrite} />
            ))}
          </ul>
        )}
      </Section>
      {canWrite ? (
        <Section title={t('routingPolicies.splits.newTitle')}>
          <form
            className="grid gap-3 md:grid-cols-3"
            onSubmit={(event: SubmitEvent) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            {(['name', 'match', 'stable', 'canary'] as const).map((field) => (
              <Field
                key={field}
                name={`split-${field}`}
                label={t(`routingPolicies.splits.${field}`)}
                required
                dir={field === 'name' ? undefined : 'ltr'}
                value={draft[field]}
                onChange={(e) => {
                  set(field, e.target.value);
                }}
              />
            ))}
            <Field
              name="split-percent"
              label={t('routingPolicies.splits.percent')}
              type="number"
              min={0}
              max={100}
              step={0.01}
              dir="ltr"
              required
              value={draft.percent}
              onChange={(e) => {
                set('percent', e.target.value);
              }}
            />
            <label htmlFor="split-stickiness" className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t('routingPolicies.splits.stickiness')}</span>
              <select
                id="split-stickiness"
                className={selectClass}
                value={draft.stickiness}
                onChange={(e) => {
                  set('stickiness', e.target.value);
                }}
              >
                {(['key', 'session', 'request'] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`routingPolicies.splits.stickinessOptions.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <Field
              name="split-rollback"
              label={t('routingPolicies.splits.autoRollback')}
              type="number"
              min={1}
              max={100}
              dir="ltr"
              value={draft.rollbackAt}
              onChange={(e) => {
                set('rollbackAt', e.target.value);
              }}
            />
            <div className="flex items-end">
              <Button type="submit" disabled={create.isPending}>
                {t('routingPolicies.splits.create')}
              </Button>
            </div>
          </form>
        </Section>
      ) : null}
    </>
  );
}
