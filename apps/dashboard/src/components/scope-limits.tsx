/**
 * Shared limits on the organization page (card 25.5): RPM, TPM, concurrency, budgets and alert
 * thresholds for the whole organization, a team, a project or a member, and for a model or
 * provider (card 33.1), with daily, weekly, monthly and yearly budgets. A budget change answered
 * with 202 is waiting for a second person's approval (card 22.2).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import type { SubmitEvent } from '../lib/form';
import { formatNumber } from '../lib/date';
import { formatUsd, listOf } from '../lib/s2-format';
import {
  type LimitDraft,
  limitBody,
  limitDraft,
  PERIODS,
  type ScopeLimit,
} from '../lib/scope-limits';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Field, FormError } from './ui/field';

type Scope = ScopeLimit['scope'];
export interface Target {
  scope: Scope;
  id: string;
  name: string;
}

const FIELDS: { key: keyof LimitDraft; label: string; dir?: 'ltr'; inputMode?: 'decimal' }[] = [
  { key: 'rpm', label: 'scopeLimits.rpm' },
  { key: 'tpm', label: 'scopeLimits.tpm' },
  { key: 'maxConcurrency', label: 'scopeLimits.concurrency' },
  { key: 'thresholds', label: 'scopeLimits.thresholds' },
  ...PERIODS.flatMap((period) => [
    {
      key: `${period}Usd` as const,
      label: `scopeLimits.${period}Usd`,
      inputMode: 'decimal' as const,
    },
    { key: `${period}Tokens` as const, label: `scopeLimits.${period}Tokens` },
  ]),
];

export function ScopeLimitsCard({
  orgId,
  organizationName,
  teams,
  projects,
  members = [],
  canManage,
  only,
  title,
  help,
  testId = 'scope-limits',
}: {
  orgId: string;
  organizationName?: string | undefined;
  teams?: { id: string; name: string }[];
  projects?: { id: string; name: string }[];
  members?: { userId: string; name: string; email: string }[];
  canManage: boolean;
  /** Edit just these scopes (e.g. end users, card 33.2); no picker. */
  only?: Target[];
  title?: string;
  help?: string;
  testId?: string;
}) {
  const { t, i18n } = useTranslation();
  // The organization page renders without the settings context, so the language comes from i18n.
  const lang = i18n.language === 'fa' ? 'fa' : 'en';
  const n = (value: number) => formatNumber(value, lang);
  const usd = (value: string) => formatUsd(value, lang);
  const qc = useQueryClient();
  const base = `/orgs/${orgId}/limits`;
  const [open, setOpen] = useState<string>();
  const [draft, setDraft] = useState<LimitDraft>(limitDraft(undefined));
  const [invalid, setInvalid] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const limits = useQuery({
    queryKey: ['scope-limits', orgId],
    queryFn: () => api<unknown>(base),
  });
  // Models and providers are only listed when they have limits; these feed the picker.
  const models = useQuery({
    queryKey: ['scope-limits', orgId, 'models'],
    queryFn: () => api<unknown>(`/orgs/${orgId}/models`),
    enabled: canManage && !only,
  });
  const providers = useQuery({
    queryKey: ['scope-limits', orgId, 'providers'],
    queryFn: () => api<unknown>(`/orgs/${orgId}/providers`),
    enabled: canManage && !only,
  });
  const [extra, setExtra] = useState<Target>();
  const done = () => qc.invalidateQueries({ queryKey: ['scope-limits', orgId] });
  const save = useMutation({
    mutationFn: async ({ target, remove }: { target: Target; remove: boolean }) => {
      const path = `${base}/${target.scope}/${encodeURIComponent(target.id)}`;
      if (remove) return api<unknown>(path, { method: 'DELETE' });
      const parsed = limitBody(draft);
      if (!parsed.ok) throw new Error('invalid');
      return api<unknown>(path, { method: 'PUT', body: parsed.body });
    },
    onSuccess: (result, { target, remove }) => {
      const queued = result !== null && typeof result === 'object' && 'changeRequest' in result;
      setNotice(
        t(queued ? 'scopeLimits.queued' : remove ? 'scopeLimits.removed' : 'scopeLimits.saved', {
          name: target.name,
        }),
      );
      setOpen(undefined);
      void done();
    },
  });

  const limited = listOf<ScopeLimit>(limits.data);
  const pickable: Target[] = [
    ...listOf<{ id: string; slug: string }>(models.data).map((m) => ({
      scope: 'model' as const,
      id: m.id,
      name: m.slug,
    })),
    ...listOf<{ id: string; name: string }>(providers.data).map((p) => ({
      scope: 'provider' as const,
      id: p.id,
      name: p.name,
    })),
  ];
  const targets: Target[] = only ?? [
    { scope: 'organization', id: orgId, name: organizationName ?? orgId },
    ...(teams ?? []).map((team) => ({ scope: 'team' as const, id: team.id, name: team.name })),
    ...(projects ?? []).map((project) => ({
      scope: 'project' as const,
      id: project.id,
      name: project.name,
    })),
    ...members.map((m) => ({ scope: 'user' as const, id: m.userId, name: m.name || m.email })),
    ...limited
      .filter((l) => l.scope === 'model' || l.scope === 'provider')
      .map((l) => ({ scope: l.scope, id: l.scopeId, name: l.name })),
    ...(extra && !limited.some((l) => l.scope === extra.scope && l.scopeId === extra.id)
      ? [extra]
      : []),
  ];
  const openEditor = (target: Target) => {
    const key = `${target.scope}:${target.id}`;
    setDraft(limitDraft(limitOf(target)));
    setInvalid(undefined);
    save.reset();
    setNotice(undefined);
    setOpen(key);
  };
  const limitOf = (target: Target) =>
    listOf<ScopeLimit>(limits.data).find(
      (l) => l.scope === target.scope && l.scopeId === target.id,
    );
  const amount = (b: ScopeLimit['budgets'][number]) =>
    [
      b.limitUsd !== null ? usd(b.limitUsd) : null,
      b.limitTokens !== null ? t('scopeLimits.summary.tokens', { n: n(b.limitTokens) }) : null,
    ]
      .filter(Boolean)
      .join(' · ');
  const summary = (limit: ScopeLimit | undefined) => {
    if (!limit) return t('scopeLimits.none');
    const parts = [
      limit.rpm !== null ? t('scopeLimits.summary.rpm', { n: n(limit.rpm) }) : null,
      limit.tpm !== null ? t('scopeLimits.summary.tpm', { n: n(limit.tpm) }) : null,
      limit.maxConcurrency !== null
        ? t('scopeLimits.summary.concurrency', { n: n(limit.maxConcurrency) })
        : null,
      ...limit.budgets.map((b) => t(`scopeLimits.summary.${b.period}`, { amount: amount(b) })),
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : t('scopeLimits.none');
  };
  const submit = (target: Target) => (event: SubmitEvent) => {
    event.preventDefault();
    const parsed = limitBody(draft);
    if (!parsed.ok) {
      const label = t(FIELDS.find((f) => f.key === parsed.field)?.label ?? '');
      setInvalid(t(`scopeLimits.invalid.${parsed.rule}`, { field: label }));
      return;
    }
    setInvalid(undefined);
    save.mutate({ target, remove: false });
  };

  return (
    <Card data-testid={testId}>
      <h2 className="font-semibold">{title ?? t('scopeLimits.title')}</h2>
      <p className="mt-1 mb-3 text-sm text-muted">{help ?? t('scopeLimits.help')}</p>
      {notice ? (
        <p role="status" className="mb-3 rounded-lg bg-brand/10 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      <FormError message={limits.error ? errorMessage(limits.error, t) : undefined} />
      {!canManage ? <p className="mb-3 text-sm text-muted">{t('scopeLimits.readOnly')}</p> : null}
      {canManage && !only && pickable.length > 0 ? (
        <label className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span>{t('scopeLimits.addTarget')}</span>
          <select
            className="h-8 rounded-lg border border-border bg-surface px-2 text-sm"
            aria-label={t('scopeLimits.addTarget')}
            title={t('scopeLimits.addTargetHelp')}
            value=""
            onChange={(event) => {
              const target = pickable.find((p) => `${p.scope}:${p.id}` === event.target.value);
              if (!target) return;
              setExtra(target);
              openEditor(target);
            }}
          >
            <option value="">{t('scopeLimits.pick')}</option>
            {pickable.map((p) => (
              <option key={`${p.scope}:${p.id}`} value={`${p.scope}:${p.id}`}>
                {t(`scopeLimits.scope.${p.scope}`)}: {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {targets.length === 0 ? (
        <p className="text-sm text-muted">{t('scopeLimits.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {targets.map((target) => {
            const key = `${target.scope}:${target.id}`;
            const limit = limitOf(target);
            return (
              <li
                key={key}
                data-testid={`limits-${target.scope}-${target.id}`}
                className="border-t border-border pt-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-medium">{target.name}</span>{' '}
                    <span className="text-xs text-muted">
                      {t(`scopeLimits.scope.${target.scope}`)}
                    </span>
                    <p className="text-xs text-muted" data-testid="limits-summary">
                      {summary(limit)}
                    </p>
                  </div>
                  {canManage ? (
                    <Button
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      aria-expanded={open === key}
                      aria-label={`${t('scopeLimits.edit')} ${target.name}`}
                      onClick={() => {
                        if (open === key) {
                          setOpen(undefined);
                          return;
                        }
                        openEditor(target);
                      }}
                    >
                      {open === key ? t('scopeLimits.close') : t('scopeLimits.edit')}
                    </Button>
                  ) : null}
                </div>
                {open === key ? (
                  <form
                    className="mt-3 flex flex-col gap-3"
                    onSubmit={submit(target)}
                    aria-label={`${t('scopeLimits.edit')} ${target.name}`}
                  >
                    <FormError
                      message={invalid ?? (save.error ? errorMessage(save.error, t) : undefined)}
                    />
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {FIELDS.map((field) => (
                        <Field
                          key={field.key}
                          name={`limit-${field.key}`}
                          id={`limit-${key}-${field.key}`}
                          label={t(field.label)}
                          dir="ltr"
                          inputMode={field.inputMode ?? 'numeric'}
                          placeholder={
                            field.key === 'thresholds' ? t('scopeLimits.thresholdsHelp') : ''
                          }
                          value={draft[field.key]}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDraft((old) => ({ ...old, [field.key]: value }));
                          }}
                        />
                      ))}
                    </div>
                    <p className="text-xs text-muted">{t('scopeLimits.emptyHelp')}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" disabled={save.isPending}>
                        {t('scopeLimits.save')}
                      </Button>
                      {limit ? (
                        <Button
                          variant="ghost"
                          className="text-danger"
                          disabled={save.isPending}
                          onClick={() => {
                            if (
                              window.confirm(t('scopeLimits.removeConfirm', { name: target.name }))
                            )
                              save.mutate({ target, remove: true });
                          }}
                        >
                          {t('scopeLimits.remove')}
                        </Button>
                      ) : null}
                    </div>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
