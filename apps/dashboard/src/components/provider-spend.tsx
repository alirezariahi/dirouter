/**
 * Budgets, quota windows and credential order of one upstream provider (card 32.6), on the
 * Providers page. API-key credentials only: consumer subscriptions signed in with OAuth are not
 * supported. A budget change answered with 202 waits for a second person's approval (card 22.2).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { text } from '../lib/form';
import {
  amountOf,
  parseWindows,
  type ProviderSpend,
  windowsText,
  withAmount,
} from '../lib/provider-spend';
import { Button } from './ui/button';
import { FormError } from './ui/field';

const STRATEGIES = ['weighted', 'fill-first', 'reset-aware'] as const;
type Strategy = (typeof STRATEGIES)[number];

const queued = (result: unknown) =>
  result !== null && typeof result === 'object' && 'changeRequest' in result;

export function ProviderSpendCard({ orgId, providerId }: { orgId: string; providerId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const path = `/orgs/${orgId}/providers/${providerId}`;
  const key = ['provider-spend', orgId, providerId];
  const spend = useQuery({
    queryKey: key,
    queryFn: () => api<ProviderSpend>(`${path}/spend`),
    enabled: Boolean(orgId),
  });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<unknown>();
  const save = useMutation({
    mutationFn: async (data: FormData) => {
      const current = spend.data;
      if (!current) return false;
      const providerAmount = text(data, 'providerBudget');
      const providerBudgets = withAmount(current.budgets, 'monthly', providerAmount);
      if (providerBudgets === 'invalid')
        throw new Error(t('quota.spend.invalid', { line: providerAmount }));
      let waiting = queued(
        await api(`${path}/spend`, {
          method: 'PUT',
          body: {
            credentialStrategy: (text(data, 'strategy') || 'weighted') as Strategy,
            budgets: providerBudgets,
          },
        }),
      );
      for (const c of current.credentials) {
        const amount = text(data, `budget-${c.id}`);
        const budgets = withAmount(c.budgets, 'daily', amount);
        if (budgets === 'invalid') throw new Error(t('quota.spend.invalid', { line: amount }));
        const windows = parseWindows(text(data, `windows-${c.id}`));
        if ('invalid' in windows)
          throw new Error(t('quota.spend.invalid', { line: windows.invalid }));
        waiting =
          queued(
            await api(`${path}/credentials/${c.id}/spend`, {
              method: 'PUT',
              body: { budgets, quotaWindows: windows },
            }),
          ) || waiting;
      }
      return waiting;
    },
    onSuccess: (waiting) => {
      setError(undefined);
      setNotice(t(waiting ? 'quota.spend.queued' : 'quota.spend.saved'));
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['health', orgId] });
    },
    onError: (e) => {
      setNotice('');
      setError(e);
    },
  });

  const data = spend.data;
  return (
    <details className="rounded-md border border-border p-3" data-testid="provider-spend">
      <summary className="cursor-pointer text-sm font-medium">{t('quota.spend.title')}</summary>
      <p className="mt-2 text-xs text-muted">{t('quota.spend.help')}</p>
      {data ? (
        <form
          key={JSON.stringify(data)}
          className="mt-3 flex flex-col gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(new FormData(e.currentTarget));
          }}
        >
          <FormError message={error ? errorMessage(error, t) : undefined} />
          <label className="flex flex-col gap-1">
            <span>{t('quota.spend.strategy')}</span>
            <select
              name="strategy"
              defaultValue={data.credentialStrategy}
              className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-brand"
            >
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {t(`quota.spend.strategies.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t('quota.spend.providerBudget')}</span>
            <input
              name="providerBudget"
              inputMode="decimal"
              dir="ltr"
              defaultValue={amountOf(data.budgets, 'monthly')}
              className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-brand"
            />
          </label>
          {data.credentials.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 border-t border-border pt-2">
              <label className="flex flex-col gap-1">
                <span>{t('quota.spend.credentialBudget', { name: c.name })}</span>
                <input
                  name={`budget-${c.id}`}
                  inputMode="decimal"
                  dir="ltr"
                  defaultValue={amountOf(c.budgets, 'daily')}
                  className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-brand"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>{t('quota.spend.windows', { name: c.name })}</span>
                <textarea
                  name={`windows-${c.id}`}
                  dir="ltr"
                  rows={2}
                  defaultValue={windowsText(c.quotaWindows)}
                  className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-brand font-mono text-xs"
                />
                <span className="text-xs text-muted">{t('quota.spend.windowsHelp')}</span>
              </label>
            </div>
          ))}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              {t('quota.spend.save')}
            </Button>
            {notice ? <span className="text-xs text-muted">{notice}</span> : null}
          </div>
        </form>
      ) : null}
    </details>
  );
}
