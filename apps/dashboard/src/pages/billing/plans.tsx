/**
 * Plans and subscriptions (card 25.2): monthly plans (a price paid from the wallet at the start of
 * each period and an included allowance that pays for usage first), switching a plan off for new
 * subscribers, and every customer's subscription with its allowance used and left.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClass,
  DataTable,
  inputClass,
  Money,
  numClass,
  rowClass,
  Status,
} from '../../components/billing/common';
import { Section } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { Field, FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { trimUsd, useBillingAccess } from '../../lib/billing';
import { formatDate } from '../../lib/date';
import { errorMessage, fieldError } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { useFormat } from '../../lib/s2-format';

interface Plan {
  id: string;
  name: string;
  priceUsd: string;
  includedUsd: string;
  active: boolean;
}
interface Subscription {
  id: string;
  organizationId: string;
  organizationName: string;
  plan: { id: string; name: string; priceUsd: string };
  status: string;
  periodStart: string;
  periodEnd: string;
  includedUsd: string;
  usedUsd: string;
  remainingUsd: string;
  cancelAtPeriodEnd: boolean;
}

const USD = /^\d{1,10}(\.\d{1,8})?$/;

export default function PlansPage() {
  const { t } = useTranslation();
  const { settings } = useFormat();
  const qc = useQueryClient();
  const { orgId, write } = useBillingAccess();
  const base = `/orgs/${orgId}/billing`;
  const [draft, setDraft] = useState({ name: '', priceUsd: '', includedUsd: '' });
  const plans = useQuery({
    queryKey: ['billing', orgId, 'plans'],
    queryFn: () => api<Plan[]>(`${base}/plans`),
    enabled: Boolean(orgId),
  });
  const subscriptions = useQuery({
    queryKey: ['billing', orgId, 'subscriptions'],
    queryFn: () => api<Subscription[]>(`${base}/subscriptions`),
    enabled: Boolean(orgId),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['billing', orgId] });
  const create = useMutation({
    mutationFn: () =>
      api<Plan>(`${base}/plans`, {
        method: 'POST',
        body: {
          name: draft.name.trim(),
          priceUsd: draft.priceUsd.trim(),
          includedUsd: draft.includedUsd.trim(),
        },
      }),
    onSuccess: async () => {
      setDraft({ name: '', priceUsd: '', includedUsd: '' });
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Plan> }) =>
      api<Plan>(`${base}/plans/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh,
  });
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    create.mutate();
  };
  const date = (value: string) =>
    formatDate(value, { calendar: settings.calendar, lang: settings.lang });
  const list = plans.data ?? [];
  const subs = subscriptions.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Section title={t('billing.plans.title')} help={t('billing.plans.help')}>
        <FormError message={update.error ? errorMessage(update.error, t) : undefined} />
        {plans.isError ? (
          <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
        ) : plans.isPending ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.plans.none')}</p>
        ) : (
          <DataTable
            testId="plan-table"
            caption={t('billing.plans.title')}
            columns={[
              { key: 'name', label: t('billing.plans.col.name') },
              { key: 'price', label: t('billing.plans.col.price') },
              { key: 'included', label: t('billing.plans.col.included') },
              { key: 'active', label: t('billing.plans.col.active') },
              { key: 'actions', label: t('billing.common.actions'), numeric: true },
            ]}
          >
            {list.map((p) => (
              <PlanRow
                key={`${p.id}:${p.priceUsd}:${p.includedUsd}:${String(p.active)}`}
                plan={p}
                disabled={!write || update.isPending}
                onSave={(body) => {
                  update.mutate({ id: p.id, body });
                }}
              />
            ))}
          </DataTable>
        )}
        <form
          onSubmit={submit}
          aria-label={t('billing.plans.create')}
          className="flex flex-col gap-2 border-t border-border pt-4"
        >
          <h3 className="text-sm font-medium">{t('billing.plans.create')}</h3>
          <fieldset
            disabled={!write || create.isPending}
            className="flex flex-wrap items-end gap-3"
          >
            <Field
              label={t('billing.plans.name')}
              name="planName"
              required
              maxLength={100}
              value={draft.name}
              onChange={(e) => {
                setDraft({ ...draft, name: e.target.value });
              }}
              error={fieldError(create.error, 'name')}
            />
            <Field
              label={t('billing.plans.price')}
              name="planPrice"
              required
              dir="ltr"
              inputMode="decimal"
              className="w-32"
              value={draft.priceUsd}
              onChange={(e) => {
                setDraft({ ...draft, priceUsd: e.target.value });
              }}
              error={fieldError(create.error, 'priceUsd')}
            />
            <Field
              label={t('billing.plans.included')}
              name="planIncluded"
              required
              dir="ltr"
              inputMode="decimal"
              className="w-32"
              value={draft.includedUsd}
              onChange={(e) => {
                setDraft({ ...draft, includedUsd: e.target.value });
              }}
              error={fieldError(create.error, 'includedUsd')}
            />
            <Button type="submit">{t('billing.plans.add')}</Button>
          </fieldset>
          <FormError message={create.error ? errorMessage(create.error, t) : undefined} />
        </form>
      </Section>

      <Section title={t('billing.subscriptions.title')} help={t('billing.subscriptions.help')}>
        {subscriptions.isError ? (
          <ErrorState error={subscriptions.error} onRetry={() => void subscriptions.refetch()} />
        ) : subscriptions.isPending ? (
          <Loading />
        ) : subs.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.subscriptions.none')}</p>
        ) : (
          <DataTable
            testId="subscription-table"
            minWidth={900}
            caption={t('billing.subscriptions.title')}
            columns={[
              { key: 'customer', label: t('billing.subscriptions.col.customer') },
              { key: 'plan', label: t('billing.subscriptions.col.plan') },
              { key: 'status', label: t('billing.subscriptions.col.status') },
              { key: 'period', label: t('billing.subscriptions.col.period') },
              { key: 'used', label: t('billing.subscriptions.col.used'), numeric: true },
              { key: 'left', label: t('billing.subscriptions.col.left'), numeric: true },
            ]}
          >
            {subs.map((s) => (
              <tr key={s.id} className={rowClass} data-testid="subscription-row">
                <td className={cellClass}>{s.organizationName}</td>
                <td className={cellClass}>
                  {s.plan.name}
                  <p className="text-xs text-muted">
                    <Money value={s.plan.priceUsd} /> {t('billing.plans.perMonth')}
                  </p>
                </td>
                <td className={cellClass}>
                  <Status
                    tone={s.status === 'active' ? (s.cancelAtPeriodEnd ? 'warn' : 'good') : 'muted'}
                    label={
                      s.status === 'active' && s.cancelAtPeriodEnd
                        ? t('billing.subscriptions.ending')
                        : t(`billing.subscriptions.status.${s.status}`, { defaultValue: s.status })
                    }
                  />
                </td>
                <td className={`${cellClass} whitespace-nowrap`}>
                  {date(s.periodStart)} – {date(s.periodEnd)}
                </td>
                <td className={numClass}>
                  <Money value={s.usedUsd} /> / <Money value={s.includedUsd} />
                </td>
                <td className={numClass}>
                  <Money value={s.remainingUsd} />
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>
    </div>
  );
}

function PlanRow({
  plan,
  disabled,
  onSave,
}: {
  plan: Plan;
  disabled: boolean;
  onSave: (body: Partial<Plan>) => void;
}) {
  const { t } = useTranslation();
  const [price, setPrice] = useState(trimUsd(plan.priceUsd));
  const [included, setIncluded] = useState(trimUsd(plan.includedUsd));
  const changed: Partial<Plan> = {
    ...(price.trim() !== trimUsd(plan.priceUsd) ? { priceUsd: price.trim() } : {}),
    ...(included.trim() !== trimUsd(plan.includedUsd) ? { includedUsd: included.trim() } : {}),
  };
  const valid = USD.test(price.trim()) && USD.test(included.trim());
  return (
    <tr className={rowClass} data-testid="plan-row">
      <td className={cellClass}>
        <p className="font-medium">{plan.name}</p>
      </td>
      <td className="px-4 py-2">
        <input
          className={`${inputClass} h-9 w-28`}
          dir="ltr"
          inputMode="decimal"
          aria-label={t('billing.plans.priceOf', { name: plan.name })}
          disabled={disabled}
          value={price}
          onChange={(e) => {
            setPrice(e.target.value);
          }}
        />
      </td>
      <td className="px-4 py-2">
        <input
          className={`${inputClass} h-9 w-28`}
          dir="ltr"
          inputMode="decimal"
          aria-label={t('billing.plans.includedOf', { name: plan.name })}
          disabled={disabled}
          value={included}
          onChange={(e) => {
            setIncluded(e.target.value);
          }}
        />
      </td>
      <td className={cellClass}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={plan.active}
            disabled={disabled}
            onChange={(e) => {
              onSave({ active: e.target.checked });
            }}
          />
          <span className="sr-only">{t('billing.plans.activeOf', { name: plan.name })}</span>
          <span aria-hidden>
            {t(plan.active ? 'billing.plans.offered' : 'billing.plans.hidden')}
          </span>
        </label>
      </td>
      <td className="px-4 py-2 text-end">
        <Button
          variant="outline"
          disabled={disabled || !valid || Object.keys(changed).length === 0}
          aria-label={t('billing.plans.saveOf', { name: plan.name })}
          onClick={() => {
            onSave(changed);
          }}
        >
          {t('billing.common.save')}
        </Button>
      </td>
    </tr>
  );
}
