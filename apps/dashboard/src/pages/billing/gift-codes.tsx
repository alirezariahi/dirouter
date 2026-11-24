/**
 * Gift and recharge codes (card 25.1): create a batch of up to 10,000 codes, take them away as a
 * CSV (the API returns the plain codes only in the create response, it stores their hashes), see
 * each batch's redemptions, and revoke several batches at once. Revoking is permanent: a revoked
 * code is refused, what was already credited stays.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  cellClass,
  DataTable,
  Money,
  Notice,
  numClass,
  rowClass,
  Status,
} from '../../components/billing/common';
import { type Batch, batchState, CODE_HEADER, codeRows } from '../../components/billing/model';
import { Section, selectClass } from '../../components/s2/common';
import { Button } from '../../components/ui/button';
import { Field, FormError } from '../../components/ui/field';
import { ErrorState, Loading } from '../../components/ui/states';
import { api } from '../../lib/api';
import { sumUsd, trimUsd, useBillingAccess } from '../../lib/billing';
import { downloadCsv } from '../../lib/csv';
import { formatDate } from '../../lib/date';
import { errorMessage, fieldError } from '../../lib/errors';
import type { SubmitEvent } from '../../lib/form';
import { useFormat } from '../../lib/s2-format';

interface Redemption {
  id: string;
  codeHint: string;
  organizationId: string;
  organizationName: string;
  transactionId: string;
  redeemedAt: string;
}
interface Draft {
  name: string;
  kind: 'gift' | 'recharge';
  amountUsd: string;
  count: string;
  maxRedemptions: string;
  expiresAt: string;
}
const EMPTY: Draft = {
  name: '',
  kind: 'gift',
  amountUsd: '',
  count: '10',
  maxRedemptions: '1',
  expiresAt: '',
};

export default function GiftCodesPage() {
  const { t } = useTranslation();
  const { n, settings } = useFormat();
  const qc = useQueryClient();
  const { orgId, write } = useBillingAccess();
  const base = `/orgs/${orgId}/billing/gift-batches`;
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [created, setCreated] = useState<{ batch: Batch; codes: string[] }>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string>();
  const [revokeNotice, setRevokeNotice] = useState<string>();

  const batches = useQuery({
    queryKey: ['billing', orgId, 'gift-batches'],
    queryFn: () => api<Batch[]>(base),
    enabled: Boolean(orgId),
  });
  const redemptions = useQuery({
    queryKey: ['billing', orgId, 'gift-redemptions', open],
    queryFn: () => api<Redemption[]>(`${base}/${open ?? ''}/redemptions`),
    enabled: Boolean(orgId && open),
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Batch & { codes: string[] }>(base, { method: 'POST', body }),
    onSuccess: (result) => {
      const { codes, ...rest } = result;
      setCreated({ batch: { ...rest, codes: codes.length }, codes });
      setDraft(EMPTY);
      void qc.invalidateQueries({ queryKey: ['billing', orgId, 'gift-batches'] });
    },
  });
  /** One request per batch, in order; stops at the first refusal and says how far it got. */
  const revoke = useMutation({
    mutationFn: async (ids: string[]) => {
      let done = 0;
      try {
        for (const id of ids) {
          await api<Batch>(`${base}/${id}/revoke`, { method: 'POST' });
          done += 1;
        }
      } finally {
        if (done > 0) setRevokeNotice(t('billing.gifts.revoked', { n: n(done) }));
        await qc.invalidateQueries({ queryKey: ['billing', orgId, 'gift-batches'] });
      }
      return done;
    },
    onSuccess: () => {
      setSelected(new Set());
    },
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setCreated(undefined);
    create.mutate({
      name: draft.name.trim(),
      kind: draft.kind,
      amountUsd: draft.amountUsd.trim(),
      count: Number(draft.count),
      maxRedemptions: Number(draft.maxRedemptions),
      // End of the chosen day in Tehran, where the operator and the customers are.
      ...(draft.expiresAt
        ? { expiresAt: new Date(`${draft.expiresAt}T23:59:59+03:30`).toISOString() }
        : {}),
    });
  };
  const date = (value: string) =>
    formatDate(value, { calendar: settings.calendar, lang: settings.lang });
  const rows = batches.data ?? [];
  const revocable = rows.filter((b) => batchState(b) !== 'revoked');
  const chosen = [...selected].filter((id) => revocable.some((b) => b.id === id));
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <Section title={t('billing.gifts.create')} help={t('billing.gifts.createHelp')}>
        <form onSubmit={submit} aria-label={t('billing.gifts.create')}>
          <fieldset
            disabled={!write || create.isPending}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="min-w-56 flex-1">
              <Field
                label={t('billing.gifts.name')}
                name="name"
                required
                maxLength={100}
                value={draft.name}
                onChange={(e) => {
                  set('name', e.target.value);
                }}
                error={fieldError(create.error, 'name')}
              />
            </div>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-[13px] font-medium text-fg-2">{t('billing.gifts.kind')}</span>
              <select
                className={selectClass}
                value={draft.kind}
                onChange={(e) => {
                  set('kind', e.target.value === 'recharge' ? 'recharge' : 'gift');
                }}
              >
                <option value="gift">{t('billing.gifts.kinds.gift')}</option>
                <option value="recharge">{t('billing.gifts.kinds.recharge')}</option>
              </select>
            </label>
            <Field
              label={t('billing.gifts.amount')}
              name="amountUsd"
              required
              dir="ltr"
              inputMode="decimal"
              className="w-32"
              value={draft.amountUsd}
              onChange={(e) => {
                set('amountUsd', e.target.value);
              }}
              error={fieldError(create.error, 'amountUsd')}
            />
            <Field
              label={t('billing.gifts.count')}
              name="count"
              type="number"
              min={1}
              max={10_000}
              required
              dir="ltr"
              className="w-28"
              value={draft.count}
              onChange={(e) => {
                set('count', e.target.value);
              }}
              error={fieldError(create.error, 'count')}
            />
            <Field
              label={t('billing.gifts.maxRedemptions')}
              name="maxRedemptions"
              type="number"
              min={1}
              required
              dir="ltr"
              className="w-28"
              value={draft.maxRedemptions}
              onChange={(e) => {
                set('maxRedemptions', e.target.value);
              }}
              error={fieldError(create.error, 'maxRedemptions')}
            />
            <Field
              label={t('billing.gifts.expires')}
              name="expiresAt"
              type="date"
              dir="ltr"
              value={draft.expiresAt}
              onChange={(e) => {
                set('expiresAt', e.target.value);
              }}
            />
            <Button type="submit">{t('billing.gifts.submit')}</Button>
          </fieldset>
        </form>
        <FormError message={create.error ? errorMessage(create.error, t) : undefined} />
        {created ? (
          <div
            data-testid="created-codes"
            className="flex flex-col gap-3 rounded-lg border border-warn/40 bg-warn/5 p-4"
          >
            <p className="text-sm font-medium">
              {t('billing.gifts.createdTitle', {
                n: n(created.codes.length),
                name: created.batch.name,
              })}
            </p>
            <p className="text-[13px] text-fg-2">{t('billing.gifts.onlyOnce')}</p>
            <ul className="flex max-h-48 flex-wrap gap-2 overflow-y-auto" dir="ltr">
              {created.codes.slice(0, 50).map((code) => (
                <li key={code}>
                  <code className="rounded bg-surface px-2 py-1 text-xs">{code}</code>
                </li>
              ))}
              {created.codes.length > 50 ? (
                <li className="text-xs text-muted">+{created.codes.length - 50}</li>
              ) : null}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  downloadCsv(
                    `dirouter-gift-codes-${created.batch.id}.csv`,
                    CODE_HEADER,
                    codeRows(created.batch, created.codes),
                  );
                }}
              >
                {t('billing.gifts.downloadCodes')}
              </Button>
              <Button
                variant="outline"
                onClick={() => void navigator.clipboard.writeText(created.codes.join('\n'))}
              >
                {t('billing.gifts.copyCodes')}
              </Button>
            </div>
          </div>
        ) : null}
      </Section>

      <Section
        title={t('billing.gifts.batches')}
        help={t('billing.gifts.batchesHelp')}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={rows.length === 0}
              onClick={() => {
                downloadCsv(
                  'dirouter-gift-batches.csv',
                  [
                    'batch_id',
                    'name',
                    'kind',
                    'amount_usd',
                    'codes',
                    'max_redemptions',
                    'redemptions',
                    'credited_usd',
                    'state',
                    'expires_at',
                    'revoked_at',
                    'created_at',
                  ],
                  rows.map((b) => [
                    b.id,
                    b.name,
                    b.kind,
                    b.amountUsd,
                    b.codes,
                    b.maxRedemptions,
                    b.redemptions,
                    b.creditedUsd,
                    batchState(b),
                    b.expiresAt ?? '',
                    b.revokedAt ?? '',
                    b.createdAt,
                  ]),
                );
              }}
            >
              {t('billing.common.exportCsv')}
            </Button>
            <Button
              variant="outline"
              className="text-danger"
              disabled={!write || chosen.length === 0 || revoke.isPending}
              onClick={() => {
                if (window.confirm(t('billing.gifts.revokeConfirm', { n: n(chosen.length) })))
                  revoke.mutate(chosen);
              }}
            >
              {t('billing.gifts.revokeSelected', { n: n(chosen.length) })}
            </Button>
          </div>
        }
      >
        <FormError message={revoke.error ? errorMessage(revoke.error, t) : undefined} />
        {revokeNotice ? <Notice tone="good">{revokeNotice}</Notice> : null}
        {batches.isError ? (
          <ErrorState error={batches.error} onRetry={() => void batches.refetch()} />
        ) : batches.isPending ? (
          <Loading />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('billing.gifts.none')}</p>
        ) : (
          <DataTable
            testId="batch-table"
            minWidth={960}
            caption={t('billing.gifts.batches')}
            columns={[
              {
                key: 'select',
                label: (
                  <input
                    type="checkbox"
                    aria-label={t('billing.gifts.selectAll')}
                    disabled={!write || revocable.length === 0}
                    checked={revocable.length > 0 && chosen.length === revocable.length}
                    onChange={(e) => {
                      setSelected(new Set(e.target.checked ? revocable.map((b) => b.id) : []));
                    }}
                  />
                ),
                className: 'w-10',
              },
              { key: 'name', label: t('billing.gifts.col.name') },
              { key: 'amount', label: t('billing.gifts.col.amount'), numeric: true },
              { key: 'used', label: t('billing.gifts.col.used'), numeric: true },
              { key: 'credited', label: t('billing.gifts.col.credited'), numeric: true },
              { key: 'state', label: t('billing.gifts.col.state') },
              { key: 'actions', label: t('billing.common.actions'), numeric: true },
            ]}
          >
            {rows.map((b) => {
              const state = batchState(b);
              return (
                <tr key={b.id} className={rowClass} data-testid="batch-row">
                  <td className={cellClass}>
                    <input
                      type="checkbox"
                      aria-label={t('billing.gifts.select', { name: b.name })}
                      disabled={!write || state === 'revoked'}
                      checked={selected.has(b.id) && state !== 'revoked'}
                      onChange={() => {
                        toggle(b.id);
                      }}
                    />
                  </td>
                  <td className={cellClass}>
                    <p className="font-medium">{b.name}</p>
                    <p className="text-xs text-muted">
                      {t(`billing.gifts.kinds.${b.kind}`)} · {date(b.createdAt)}
                    </p>
                  </td>
                  <td className={numClass}>
                    <Money value={b.amountUsd} />
                  </td>
                  <td className={numClass}>
                    <bdi>
                      {n(b.redemptions)} / {n(b.codes * b.maxRedemptions)}
                    </bdi>
                  </td>
                  <td className={numClass}>
                    <Money value={b.creditedUsd} />
                  </td>
                  <td className={cellClass}>
                    <Status
                      tone={state === 'active' ? 'good' : state === 'revoked' ? 'danger' : 'muted'}
                      label={t(`billing.gifts.state.${state}`)}
                    />
                    {b.expiresAt ? (
                      <p className="mt-1 text-xs text-muted">
                        {t('billing.gifts.expiresOn', { date: date(b.expiresAt) })}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-end">
                    <Button
                      variant="ghost"
                      aria-expanded={open === b.id}
                      onClick={() => {
                        setOpen(open === b.id ? undefined : b.id);
                      }}
                    >
                      {t('billing.gifts.redemptions')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Section>

      {open ? (
        <Section
          title={t('billing.gifts.redemptionsOf', {
            name: rows.find((b) => b.id === open)?.name ?? open,
          })}
        >
          {redemptions.isPending ? (
            <Loading />
          ) : redemptions.isError ? (
            <ErrorState error={redemptions.error} onRetry={() => void redemptions.refetch()} />
          ) : redemptions.data.length === 0 ? (
            <p className="text-sm text-muted">{t('billing.gifts.noRedemptions')}</p>
          ) : (
            <DataTable
              testId="redemption-table"
              caption={t('billing.gifts.redemptions')}
              columns={[
                { key: 'when', label: t('billing.gifts.col.when') },
                { key: 'code', label: t('billing.gifts.col.code') },
                { key: 'customer', label: t('billing.gifts.col.customer') },
                { key: 'transaction', label: t('billing.gifts.col.transaction') },
              ]}
            >
              {redemptions.data.map((r) => (
                <tr key={r.id} className={rowClass}>
                  <td className={`${cellClass} whitespace-nowrap`}>{date(r.redeemedAt)}</td>
                  <td className={cellClass}>
                    <code dir="ltr" className="text-xs">
                      {r.codeHint}…
                    </code>
                  </td>
                  <td className={cellClass}>{r.organizationName}</td>
                  <td className={cellClass}>
                    <code dir="ltr" className="text-xs text-muted">
                      {r.transactionId}
                    </code>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Section>
      ) : null}
      <p className="text-xs text-muted">
        {t('billing.gifts.totalCredited', {
          amount: `$${trimUsd(sumUsd(rows.map((b) => b.creditedUsd)))}`,
        })}
      </p>
    </div>
  );
}
