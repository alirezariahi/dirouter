/**
 * Upstream account balance (card 32.9): the credit left on a provider account, per credential,
 * and a button that looks it up now. Balances are refreshed by the gateway on a schedule too.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { formatDate } from '../lib/date';
import { useSettings } from '../settings';
import { Button } from './ui/button';

export interface CredentialBalanceView {
  kind: string;
  ok: boolean;
  amount: string | null;
  currency: string | null;
  error: string | null;
  checkedAt: string;
}

export function CredentialBalance({
  balance,
}: {
  balance: CredentialBalanceView | null | undefined;
}) {
  const { t } = useTranslation();
  const settings = useSettings();
  if (!balance) return null;
  const when = formatDate(balance.checkedAt, {
    calendar: settings.calendar,
    lang: settings.lang,
    time: true,
  });
  return (
    <span className="mt-1 block text-xs" data-testid="credential-balance">
      {balance.amount !== null ? (
        <span className={balance.ok ? 'text-fg' : 'text-muted'}>
          {t('upstreamServices.balance.amount', {
            amount: balance.amount,
            currency: balance.currency ?? '',
          })}
        </span>
      ) : null}
      {!balance.ok ? (
        <span className="block text-danger" dir="ltr">
          {t('upstreamServices.balance.failed', { error: balance.error ?? '' })}
        </span>
      ) : null}
      <span className="block text-muted">
        {t('upstreamServices.balance.checkedAt', { date: when })}
      </span>
    </span>
  );
}

export function RefreshBalanceButton({
  org,
  providerId,
  onError,
}: {
  org: string;
  providerId: string;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () =>
      api<unknown>(`/orgs/${org}/providers/${providerId}/balance`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers', org] });
    },
    onError,
  });
  return (
    <Button
      variant="outline"
      onClick={() => {
        refresh.mutate();
      }}
      disabled={refresh.isPending}
    >
      {refresh.isPending
        ? t('upstreamServices.balance.refreshing')
        : t('upstreamServices.balance.refresh')}
    </Button>
  );
}
