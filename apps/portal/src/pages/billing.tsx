/** Top-up, gift codes, plans, payments and the wallet statement. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SyntheticEvent, useState } from 'react';

import { api } from '../lib/api';
import { date, usd } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { query } from '../lib/router';
import { orgId } from '../lib/session';
import { Button, Card, Field, Mono, Notice } from '../lib/ui';
import { useWallet } from '../lib/wallet';

interface Options {
  providers: ('zarinpal' | 'stripe')[];
  topup: { minUsd: string; maxUsd: string };
}
interface Entry {
  id: string;
  kind: string;
  description: string | null;
  amountUsd: string;
  balanceAfterUsd: string | null;
  createdAt: string;
}
interface Payment {
  id: string;
  provider: string;
  status: string;
  amountUsd: string;
  createdAt: string;
}
interface Plan {
  id: string;
  name: string;
  priceUsd: string;
  includedUsd: string;
}
interface Subscription {
  plan: { name: string };
  status: string;
  periodEnd: string;
  remainingUsd: string;
  includedUsd: string;
  cancelAtPeriodEnd: boolean;
}

export function BillingPage() {
  const { t, lang } = useI18n();
  const org = orgId();
  const client = useQueryClient();
  const refresh = () => void client.invalidateQueries();
  const wallet = useWallet();
  const options = useQuery({
    queryKey: ['payment-options', org],
    queryFn: () => api<Options>(`/orgs/${org}/wallet/payment-options`),
  });
  const statement = useQuery({
    queryKey: ['statement', org],
    queryFn: () => api<Entry[]>(`/orgs/${org}/wallet/statement?limit=50`),
  });
  const payments = useQuery({
    queryKey: ['payments', org],
    queryFn: () => api<Payment[]>(`/orgs/${org}/wallet/payments?limit=20`),
  });
  const plans = useQuery({
    queryKey: ['plans', org],
    queryFn: () => api<Plan[]>(`/orgs/${org}/wallet/plans`),
  });
  const subscription = useQuery({
    queryKey: ['subscription', org],
    queryFn: () => api<Subscription | null>(`/orgs/${org}/wallet/subscription`),
  });

  const [amount, setAmount] = useState('10');
  const [code, setCode] = useState('');
  const pay = useMutation({
    mutationFn: (provider: string) =>
      api<{ redirectUrl: string }>(`/orgs/${org}/wallet/payments`, {
        method: 'POST',
        body: { provider, amountUsd: amount, returnUrl: `${window.location.origin}/app/billing` },
      }),
    onSuccess: (r) => {
      window.location.assign(r.redirectUrl);
    },
  });
  const redeem = useMutation({
    mutationFn: () =>
      api<{ amountUsd: string }>(`/orgs/${org}/wallet/redeem`, { method: 'POST', body: { code } }),
    onSuccess: () => {
      setCode('');
      refresh();
    },
  });
  const subscribe = useMutation({
    mutationFn: (planId: string) =>
      api(`/orgs/${org}/wallet/subscription`, { method: 'POST', body: { planId } }),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => api(`/orgs/${org}/wallet/subscription`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const returned = query('status');
  const sub = subscription.data;
  return (
    <div className="space-y-6">
      {returned && (
        <Notice
          tone={returned === 'succeeded' ? 'success' : returned === 'pending' ? 'info' : 'error'}
        >
          {t.paymentResult}: {returned}
        </Notice>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t.topUp}>
          <p className="mb-3 text-sm text-stone-600">
            {t.balance}: <Mono>{usd(wallet.data?.wallet?.balanceUsd)}</Mono>
          </p>
          {options.data && options.data.providers.length === 0 ? (
            <Notice>{t.noProviders}</Notice>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
                e.preventDefault();
              }}
            >
              <Field
                label={t.amountUsd}
                type="number"
                min={options.data?.topup.minUsd}
                max={options.data?.topup.maxUsd}
                step="0.01"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
                dir="ltr"
              />
              <div className="flex gap-2">
                {options.data?.providers.map((p) => (
                  <Button
                    key={p}
                    onClick={() => {
                      pay.mutate(p);
                    }}
                    disabled={pay.isPending}
                  >
                    {t.pay} · {p === 'zarinpal' ? 'زرین‌پال' : 'Stripe'}
                  </Button>
                ))}
              </div>
              {pay.error && <Notice tone="error">{pay.error.message}</Notice>}
            </form>
          )}
        </Card>
        <Card title={t.redeem}>
          <form
            className="space-y-3"
            onSubmit={(e: SyntheticEvent<HTMLFormElement>) => {
              e.preventDefault();
              redeem.mutate();
            }}
          >
            <Field
              label="DR-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
              dir="ltr"
              required
            />
            <Button type="submit" disabled={redeem.isPending}>
              {t.redeemAction}
            </Button>
            {redeem.isSuccess && (
              <Notice tone="success">
                {t.redeemed}: <Mono>{usd(redeem.data.amountUsd)}</Mono>
              </Notice>
            )}
            {redeem.error && <Notice tone="error">{redeem.error.message}</Notice>}
          </form>
        </Card>
      </div>

      {(plans.data?.length ?? 0) > 0 && (
        <Card title={t.plans}>
          {sub && sub.status !== 'cancelled' && (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-md bg-stone-50 p-3 text-sm">
              <span>
                {t.subscription}: <strong>{sub.plan.name}</strong> · {t.remaining}{' '}
                <Mono>{usd(sub.remainingUsd)}</Mono> · {t.renews} {date(sub.periodEnd, lang)}
              </span>
              {!sub.cancelAtPeriodEnd && (
                <Button
                  variant="quiet"
                  onClick={() => {
                    cancel.mutate();
                  }}
                >
                  {t.cancelPlan}
                </Button>
              )}
            </div>
          )}
          <ul className="grid gap-3 sm:grid-cols-3">
            {plans.data?.map((p) => (
              <li key={p.id} className="rounded-md border border-stone-200 p-4">
                <p className="font-medium">{p.name}</p>
                <p className="text-sm text-stone-600">
                  <Mono>{usd(p.priceUsd)}</Mono> {t.perMonth} · <Mono>{usd(p.includedUsd)}</Mono>{' '}
                  {t.included}
                </p>
                <Button
                  className="mt-3"
                  onClick={() => {
                    subscribe.mutate(p.id);
                  }}
                  disabled={subscribe.isPending}
                >
                  {t.subscribe}
                </Button>
              </li>
            ))}
          </ul>
          {subscribe.error && <Notice tone="error">{subscribe.error.message}</Notice>}
        </Card>
      )}

      <Card title={t.statement}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-stone-500">
              <tr className="border-b border-stone-200">
                <th className="py-2 text-start font-medium">{t.date}</th>
                <th className="py-2 text-start font-medium">{t.description}</th>
                <th className="py-2 text-start font-medium">{t.amount}</th>
                <th className="py-2 text-start font-medium">{t.balance}</th>
              </tr>
            </thead>
            <tbody>
              {statement.data?.map((e) => (
                <tr key={e.id} className="border-b border-stone-100 last:border-0">
                  <td className="py-2 text-stone-600">{date(e.createdAt, lang)}</td>
                  <td className="py-2">{e.description ?? e.kind}</td>
                  <td
                    className={`py-2 ${e.amountUsd.startsWith('-') ? 'text-stone-900' : 'text-teal-700'}`}
                  >
                    <Mono>{usd(e.amountUsd, 2)}</Mono>
                  </td>
                  <td className="py-2">
                    <Mono>{usd(e.balanceAfterUsd)}</Mono>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t.payments}>
        {payments.isSuccess && payments.data.length === 0 && <Notice>{t.noPayments}</Notice>}
        <ul className="divide-y divide-stone-100 text-sm">
          {payments.data?.map((p) => (
            <li key={p.id} className="flex justify-between gap-4 py-2">
              <span>
                {p.provider} · {date(p.createdAt, lang)}
              </span>
              <span>
                <Mono>{usd(p.amountUsd)}</Mono> · {p.status}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
