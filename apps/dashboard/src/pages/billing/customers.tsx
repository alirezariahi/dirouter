/**
 * Customers and wallets (card 25.1): every customer organization with its balance, and for the one
 * selected its wallet, prepaid mode, the statement (newest first, with the running balance) and a
 * manual credit or debit with a required reason. The API records each manual adjustment in the
 * platform's audit log (`billing.wallet_adjusted`) and the idempotency key makes a double click
 * harmless. The ledger check proves the double-entry books still balance.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClass,
  DataTable,
  inputClass,
  Money,
  Notice,
  numClass,
  rowClass,
  Status,
} from '../../components/billing/common';
import { type CustomerWallet, useCustomers } from '../../components/billing/model';
import { Section, selectClass, Stat } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { Field, FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { idempotencyKey, sumUsd, trimUsd, USD_PATTERN, useBillingAccess } from '../../lib/billing';
import { downloadCsv } from '../../lib/csv';
import { formatDate } from '../../lib/date';
import { errorMessage, fieldError } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { useFormat } from '../../lib/s2-format';

interface WalletSummary {
  prepaid: boolean;
  wallet: {
    id: string;
    balanceUsd: string;
    heldUsd: string;
    availableUsd: string;
    updatedAt: string;
  } | null;
}
interface Entry {
  id: string;
  transactionId: string;
  kind: string;
  description: string | null;
  amountUsd: string;
  balanceAfterUsd: string | null;
  createdAt: string;
}
interface LedgerCheck {
  ok: boolean;
  totalUsd: string;
  unbalancedTransactions: number;
  driftedWallets: number;
}

const PAGE = 100;

export default function CustomersPage() {
  const { t } = useTranslation();
  const { n } = useFormat();
  const { orgId } = useBillingAccess();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string>();
  const customers = useCustomers(orgId);
  const ledger = useQuery({
    queryKey: ['billing', orgId, 'ledger-check'],
    queryFn: () => api<LedgerCheck>(`/orgs/${orgId}/billing/ledger/check`),
    enabled: Boolean(orgId),
  });

  if (customers.isError)
    return <ErrorState error={customers.error} onRetry={() => void customers.refetch()} />;
  if (!customers.data) return <Loading />;
  const all = customers.data;
  const needle = search.trim().toLowerCase();
  const rows = needle
    ? all.filter((c) =>
        [c.name, c.slug, c.organizationId].some((v) => v.toLowerCase().includes(needle)),
      )
    : all;
  const current = all.find((c) => c.organizationId === selected);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Stat label={t('billing.customers.count')} value={n(all.length)} />
        <Stat
          label={t('billing.customers.totalBalance')}
          value={`$${trimUsd(sumUsd(all.map((c) => c.balanceUsd)))}`}
          hint={t('billing.customers.prepaidCount', {
            n: n(all.filter((c) => c.prepaid).length),
          })}
        />
        <LedgerStat
          check={ledger.data}
          failed={ledger.isError}
          onCheck={() => void ledger.refetch()}
        />
      </div>

      <Section
        title={t('billing.customers.title')}
        help={t('billing.customers.help')}
        action={
          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              aria-label={t('billing.customers.search')}
              placeholder={t('billing.customers.search')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              className={`${inputClass} h-9 w-56`}
            />
            <Button
              variant="outline"
              disabled={rows.length === 0}
              onClick={() => {
                downloadCsv(
                  'dirouter-customer-balances.csv',
                  ['organization_id', 'name', 'slug', 'prepaid', 'balance_usd'],
                  rows.map((c) => [
                    c.organizationId,
                    c.name,
                    c.slug,
                    String(c.prepaid),
                    c.balanceUsd,
                  ]),
                );
              }}
            >
              {t('billing.common.exportCsv')}
            </Button>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted">
            {all.length === 0 ? t('billing.customers.none') : t('billing.common.noMatch')}
          </p>
        ) : (
          <DataTable
            testId="customer-table"
            caption={t('billing.customers.title')}
            columns={[
              { key: 'name', label: t('billing.customers.col.name') },
              { key: 'mode', label: t('billing.customers.col.mode') },
              { key: 'balance', label: t('billing.customers.col.balance'), numeric: true },
              { key: 'actions', label: t('billing.common.actions'), numeric: true },
            ]}
          >
            {rows.map((c) => (
              <tr
                key={c.organizationId}
                className={rowClass}
                aria-selected={c.organizationId === selected}
                data-testid="customer-row"
              >
                <td className={cellClass}>
                  <p className="font-medium">{c.name}</p>
                  <code dir="ltr" className="text-xs text-muted">
                    {c.slug}
                  </code>
                </td>
                <td className={cellClass}>
                  <Status
                    tone={c.prepaid ? 'brand' : 'muted'}
                    label={t(
                      c.prepaid ? 'billing.customers.prepaid' : 'billing.customers.postpaid',
                    )}
                  />
                </td>
                <td className={numClass}>
                  <Money value={c.balanceUsd} />
                </td>
                <td className="px-4 py-2 text-end">
                  <Button
                    variant={c.organizationId === selected ? 'primary' : 'outline'}
                    aria-label={t('billing.customers.open', { name: c.name })}
                    onClick={() => {
                      setSelected(c.organizationId);
                    }}
                  >
                    {t('billing.customers.wallet')}
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>

      {current ? <CustomerWalletPanel key={current.organizationId} customer={current} /> : null}
    </div>
  );
}

function LedgerStat({
  check,
  failed,
  onCheck,
}: {
  check: LedgerCheck | undefined;
  failed: boolean;
  onCheck: () => void;
}) {
  const { t } = useTranslation();
  const { n } = useFormat();
  const label = failed
    ? t('billing.ledger.failed')
    : !check
      ? t('billing.ledger.checking')
      : check.ok
        ? t('billing.ledger.ok')
        : t('billing.ledger.broken');
  return (
    <div data-testid="ledger-check" className="contents">
      <Stat
        label={t('billing.ledger.title')}
        value={label}
        hint={
          check
            ? t('billing.ledger.detail', {
                unbalanced: n(check.unbalancedTransactions),
                drifted: n(check.driftedWallets),
              })
            : undefined
        }
        delta={
          <Button variant="ghost" className="h-7 self-start px-2 text-xs" onClick={onCheck}>
            {t('billing.ledger.recheck')}
          </Button>
        }
      />
    </div>
  );
}

function CustomerWalletPanel({ customer }: { customer: CustomerWallet }) {
  const { t } = useTranslation();
  const { settings } = useFormat();
  const qc = useQueryClient();
  const { orgId, write } = useBillingAccess();
  const base = `/orgs/${orgId}/billing/wallets/${customer.organizationId}`;
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(idempotencyKey);
  const [localError, setLocalError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [older, setOlder] = useState<Entry[]>([]);
  const [exhausted, setExhausted] = useState(false);

  const summary = useQuery({
    queryKey: ['billing', orgId, 'wallet', customer.organizationId],
    queryFn: () => api<WalletSummary>(base),
  });
  const statement = useQuery({
    queryKey: ['billing', orgId, 'statement', customer.organizationId],
    queryFn: () => api<Entry[]>(`${base}/statement`, { query: { limit: PAGE } }),
  });
  const refresh = async () => {
    setOlder([]);
    setExhausted(false);
    await qc.invalidateQueries({ queryKey: ['billing', orgId] });
  };
  const prepaid = useMutation({
    mutationFn: (value: boolean) =>
      api<WalletSummary>(base, { method: 'PATCH', body: { prepaid: value } }),
    onSuccess: refresh,
  });
  const adjust = useMutation({
    mutationFn: (body: { amountUsd: string; reason: string; idempotencyKey: string }) =>
      api<{ transactionId: string; created: boolean }>(`${base}/adjustments`, {
        method: 'POST',
        body,
      }),
    onSuccess: async (result) => {
      setNotice(
        result.created
          ? t('billing.adjust.done', { id: result.transactionId })
          : t('billing.adjust.duplicate', { id: result.transactionId }),
      );
      setAmount('');
      setReason('');
      // The next adjustment is a new operation; this one may still be retried until it lands.
      setKey(idempotencyKey());
      await refresh();
    },
  });
  const loadOlder = useMutation({
    mutationFn: (before: string) =>
      api<Entry[]>(`${base}/statement`, { query: { limit: PAGE, before } }),
    onSuccess: (rows) => {
      setOlder((current) => [...current, ...rows]);
      if (rows.length < PAGE) setExhausted(true);
    },
  });

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setNotice(undefined);
    setLocalError(undefined);
    const value = amount.trim();
    if (!USD_PATTERN.test(value) || value.startsWith('-') || /^0+(\.0+)?$/.test(value)) {
      setLocalError(t('billing.adjust.badAmount'));
      return;
    }
    if (reason.trim().length < 3) {
      setLocalError(t('billing.adjust.badReason'));
      return;
    }
    const signed = direction === 'debit' ? `-${value}` : value;
    const confirmText = t(
      direction === 'debit' ? 'billing.adjust.confirmDebit' : 'billing.adjust.confirmCredit',
      { amount: value, name: customer.name },
    );
    if (!window.confirm(confirmText)) return;
    adjust.mutate({ amountUsd: signed, reason: reason.trim(), idempotencyKey: key });
  };

  const entries = [...(statement.data ?? []), ...older];
  const last = entries.at(-1);
  const wallet = summary.data?.wallet;
  const date = (value: string) =>
    formatDate(value, { calendar: settings.calendar, lang: settings.lang, time: true });
  const failure = prepaid.error ?? summary.error ?? statement.error ?? loadOlder.error;

  return (
    <Section
      title={t('billing.wallet.title', { name: customer.name })}
      help={t('billing.wallet.help')}
      className="scroll-mt-20"
    >
      <div data-testid="wallet-panel" className="flex flex-col gap-5">
        <FormError message={failure ? errorMessage(failure, t) : undefined} />
        {summary.isPending ? (
          <Loading />
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            {(['balanceUsd', 'heldUsd', 'availableUsd'] as const).map((field) => (
              <div key={field} className="rounded-lg bg-surface-2/60 px-4 py-3">
                <p className="text-[13px] text-fg-2">{t(`billing.wallet.${field}`)}</p>
                <p className="mt-1 text-xl font-medium" data-testid={`wallet-${field}`}>
                  <Money value={wallet?.[field] ?? '0'} />
                </p>
              </div>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={summary.data?.prepaid ?? customer.prepaid}
            disabled={!write || prepaid.isPending || summary.isPending}
            onChange={(e) => {
              prepaid.mutate(e.target.checked);
            }}
          />
          {t('billing.wallet.prepaid')}
        </label>
        <p className="-mt-3 text-xs text-muted">{t('billing.wallet.prepaidHelp')}</p>

        <form
          onSubmit={submit}
          aria-label={t('billing.adjust.title')}
          className="flex flex-col gap-3 rounded-lg border border-border p-4"
        >
          <div>
            <h3 className="text-sm font-medium">{t('billing.adjust.title')}</h3>
            <p className="mt-0.5 text-[13px] text-muted">{t('billing.adjust.help')}</p>
          </div>
          <fieldset
            disabled={!write || adjust.isPending}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-medium text-fg-2">
                {t('billing.adjust.direction')}
              </span>
              <select
                className={selectClass}
                value={direction}
                onChange={(e) => {
                  setDirection(e.target.value === 'debit' ? 'debit' : 'credit');
                }}
              >
                <option value="credit">{t('billing.adjust.credit')}</option>
                <option value="debit">{t('billing.adjust.debit')}</option>
              </select>
            </label>
            <Field
              label={t('billing.adjust.amount')}
              name="amountUsd"
              inputMode="decimal"
              dir="ltr"
              className="w-36"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
              }}
              error={fieldError(adjust.error, 'amountUsd')}
            />
            <div className="min-w-64 flex-1">
              <Field
                label={t('billing.adjust.reason')}
                name="reason"
                value={reason}
                maxLength={500}
                onChange={(e) => {
                  setReason(e.target.value);
                }}
                error={fieldError(adjust.error, 'reason')}
              />
            </div>
            <Button type="submit">{t('billing.adjust.submit')}</Button>
          </fieldset>
          <FormError
            message={localError ?? (adjust.error ? errorMessage(adjust.error, t) : undefined)}
          />
          {notice ? <Notice tone="good">{notice}</Notice> : null}
        </form>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t('billing.statement.title')}</h3>
            <Button
              variant="outline"
              disabled={entries.length === 0}
              onClick={() => {
                downloadCsv(
                  `dirouter-statement-${customer.slug}.csv`,
                  [
                    'created_at',
                    'kind',
                    'description',
                    'amount_usd',
                    'balance_after_usd',
                    'transaction_id',
                  ],
                  entries.map((e) => [
                    e.createdAt,
                    e.kind,
                    e.description ?? '',
                    e.amountUsd,
                    e.balanceAfterUsd ?? '',
                    e.transactionId,
                  ]),
                );
              }}
            >
              {t('billing.common.exportCsv')}
            </Button>
          </div>
          {statement.isPending ? (
            <Loading />
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted">{t('billing.statement.none')}</p>
          ) : (
            <DataTable
              testId="statement-table"
              caption={t('billing.statement.title')}
              columns={[
                { key: 'when', label: t('billing.statement.col.when') },
                { key: 'kind', label: t('billing.statement.col.kind') },
                { key: 'description', label: t('billing.statement.col.description') },
                { key: 'amount', label: t('billing.statement.col.amount'), numeric: true },
                { key: 'balance', label: t('billing.statement.col.balance'), numeric: true },
              ]}
            >
              {entries.map((e) => (
                <tr key={e.id} className={rowClass}>
                  <td className={`${cellClass} whitespace-nowrap`}>{date(e.createdAt)}</td>
                  <td className={cellClass}>
                    {t(`billing.kind.${e.kind}`, { defaultValue: e.kind })}
                  </td>
                  <td className={`${cellClass} text-fg-2`}>{e.description ?? '—'}</td>
                  <td
                    className={`${numClass} ${e.amountUsd.startsWith('-') ? 'text-danger' : 'text-good'}`}
                  >
                    <Money value={e.amountUsd} signed />
                  </td>
                  <td className={numClass}>
                    {e.balanceAfterUsd === null ? '—' : <Money value={e.balanceAfterUsd} />}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          {last && !exhausted && (statement.data?.length ?? 0) >= PAGE ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={loadOlder.isPending}
              onClick={() => {
                loadOlder.mutate(last.createdAt);
              }}
            >
              {t('billing.statement.older')}
            </Button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
