/**
 * Payment settings (card 25.1): which gateways customers are offered (Zarinpal, Stripe), the
 * exchange rates used to charge in another currency (Zarinpal charges in rials, so it needs an IRR
 * rate), the top-up limits and the self-service portal. Stored as one row and read on every use,
 * so a change applies at once. A gateway is only offered when it is also configured in the API's
 * environment; `available` says which ones really are.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { inputClass, Notice, Status } from '../../components/billing/common';
import {
  type BillingSettings,
  draftOf,
  PROVIDERS,
  type SettingsDraft as Draft,
  type SettingsProblem,
  settingsBody,
} from '../../components/billing/model';
import { Section } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { Field, FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { useBillingAccess } from '../../lib/billing';
import { errorMessage, fieldError } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';

export default function BillingSettingsPage() {
  const { orgId } = useBillingAccess();
  const query = useQuery({
    queryKey: ['billing', orgId, 'settings'],
    queryFn: () => api<BillingSettings>(`/orgs/${orgId}/billing/settings`),
    enabled: Boolean(orgId),
  });
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <Loading />;
  return <SettingsForm settings={query.data} />;
}

function SettingsForm({ settings }: { settings: BillingSettings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { orgId, write } = useBillingAccess();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  const [problem, setProblem] = useState<SettingsProblem>();
  const save = useMutation({
    mutationFn: (body: Omit<BillingSettings, 'available'>) =>
      api<BillingSettings>(`/orgs/${orgId}/billing/settings`, { method: 'PUT', body }),
    onSuccess: (saved) => {
      qc.setQueryData(['billing', orgId, 'settings'], saved);
      setDraft(draftOf(saved));
    },
  });
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    save.reset();
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const result = settingsBody(draft);
    if ('problem' in result) {
      setProblem(result.problem);
      return;
    }
    setProblem(undefined);
    save.mutate(result.body);
  };
  const available = save.data?.available ?? settings.available;
  const setRate = (index: number, patch: Partial<Draft['rates'][number]>) => {
    set(
      'rates',
      draft.rates.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-6"
      aria-label={t('billing.settings.title')}
    >
      <fieldset disabled={!write || save.isPending} className="contents">
        <Section title={t('billing.settings.gateways')} help={t('billing.settings.gatewaysHelp')}>
          <ul className="flex flex-col gap-3">
            {PROVIDERS.map((p) => {
              const offered = draft.providers.includes(p);
              const live = available.includes(p);
              return (
                <li
                  key={p}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={offered}
                      onChange={(e) => {
                        set(
                          'providers',
                          e.target.checked
                            ? [...draft.providers, p]
                            : draft.providers.filter((x) => x !== p),
                        );
                      }}
                    />
                    {t(`billing.provider.${p}`)}
                  </label>
                  <span data-testid={`gateway-${p}`} className="text-[13px]">
                    <Status
                      tone={live ? 'good' : offered ? 'warn' : 'muted'}
                      label={t(
                        live
                          ? 'billing.settings.live'
                          : offered
                            ? `billing.settings.notReady.${p}`
                            : 'billing.settings.off',
                      )}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title={t('billing.settings.rates')} help={t('billing.settings.ratesHelp')}>
          <div className="flex flex-col gap-2">
            {draft.rates.map((r, i) => (
              <div key={i} className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-[13px] font-medium text-fg-2">
                    {t('billing.settings.currency')}
                  </span>
                  <input
                    className={`${inputClass} w-24 uppercase`}
                    dir="ltr"
                    maxLength={3}
                    aria-label={t('billing.settings.currencyN', { n: i + 1 })}
                    value={r.currency}
                    onChange={(e) => {
                      setRate(i, { currency: e.target.value.toUpperCase() });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-[13px] font-medium text-fg-2">
                    {t('billing.settings.perUsd')}
                  </span>
                  <input
                    className={`${inputClass} w-48`}
                    dir="ltr"
                    inputMode="decimal"
                    aria-label={t('billing.settings.rateFor', { currency: r.currency || '…' })}
                    value={r.rate}
                    onChange={(e) => {
                      setRate(i, { rate: e.target.value });
                    }}
                  />
                </label>
                <Button
                  variant="ghost"
                  onClick={() => {
                    set(
                      'rates',
                      draft.rates.filter((_, j) => j !== i),
                    );
                  }}
                >
                  {t('billing.common.remove')}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              className="self-start"
              onClick={() => {
                set('rates', [
                  ...draft.rates,
                  {
                    currency: draft.rates.some((r) => r.currency === 'IRR') ? '' : 'IRR',
                    rate: '',
                  },
                ]);
              }}
            >
              {t('billing.settings.addRate')}
            </Button>
          </div>
        </Section>

        <Section title={t('billing.settings.limits')} help={t('billing.settings.limitsHelp')}>
          <div className="flex flex-wrap gap-3">
            <Field
              label={t('billing.settings.minUsd')}
              name="topup.minUsd"
              dir="ltr"
              inputMode="decimal"
              value={draft.minUsd}
              onChange={(e) => {
                set('minUsd', e.target.value);
              }}
              error={fieldError(save.error, 'topup.minUsd')}
            />
            <Field
              label={t('billing.settings.maxUsd')}
              name="topup.maxUsd"
              dir="ltr"
              inputMode="decimal"
              value={draft.maxUsd}
              onChange={(e) => {
                set('maxUsd', e.target.value);
              }}
              error={fieldError(save.error, 'topup.maxUsd')}
            />
          </div>
        </Section>

        <Section title={t('billing.settings.portal')} help={t('billing.settings.portalHelp')}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.signupEnabled}
              onChange={(e) => {
                set('signupEnabled', e.target.checked);
              }}
            />
            {t('billing.settings.signup')}
          </label>
          <Field
            label={t('billing.settings.welcome')}
            name="portal.welcomeCreditUsd"
            dir="ltr"
            inputMode="decimal"
            className="w-48"
            value={draft.welcomeCreditUsd}
            onChange={(e) => {
              set('welcomeCreditUsd', e.target.value);
            }}
          />
        </Section>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!write || save.isPending}>
          {t('billing.settings.save')}
        </Button>
        {save.isSuccess ? <Notice tone="good">{t('billing.settings.saved')}</Notice> : null}
      </div>
      <FormError
        message={
          problem
            ? t(`billing.settings.problem.${problem}`)
            : save.error
              ? errorMessage(save.error, t)
              : undefined
        }
      />
    </form>
  );
}
