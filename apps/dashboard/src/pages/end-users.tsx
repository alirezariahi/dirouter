/**
 * End users (card 33.2): the users of the organization's own product as requests name them. The
 * defaults every end user gets, the list with this month's usage, blocking, and one end user's
 * own limits and last 30 days.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EndUsersControllerGet200, EndUsersControllerList200 } from '../api/generated';
import { PageHeader, Section, selectClass } from '../components/s2/common';
import { ScopeLimitsCard } from '../components/scope-limits';
import { Button } from '../components/ui/button';
import { FormError } from '../components/ui/field';
import { ErrorState, Loading } from '../components/ui/states';
import { api } from '../lib/api';
import { formatDate } from '../lib/date';
import { errorMessage } from '../lib/errors';
import { useFormat } from '../lib/s2-format';
import { can, currentOrg } from '../lib/session';

const PAGE = 50;
type Status = 'all' | 'active' | 'blocked';

export default function EndUsersPage() {
  const { t } = useTranslation();
  const { n, usd, settings } = useFormat();
  const org = currentOrg();
  const orgId = org?.id ?? '';
  const canManage = can(org, 'org:write');
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status>('all');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const base = `/orgs/${orgId}/end-users`;

  const list = useQuery({
    queryKey: ['end-users', orgId, search, status, offset],
    queryFn: () =>
      api<EndUsersControllerList200>(base, {
        query: {
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(status === 'all' ? {} : { blocked: status === 'blocked' ? 'true' : 'false' }),
          limit: String(PAGE),
          offset: String(offset),
        },
      }),
    enabled: Boolean(org),
    placeholderData: keepPreviousData,
  });
  const detail = useQuery({
    queryKey: ['end-users', orgId, 'detail', open],
    queryFn: () => api<EndUsersControllerGet200>(`${base}/${encodeURIComponent(open ?? '')}`),
    enabled: Boolean(org && open),
  });
  const block = useMutation({
    mutationFn: ({ id, blocked }: { id: string; blocked: boolean }) =>
      api<unknown>(`${base}/${encodeURIComponent(id)}`, { method: 'PUT', body: { blocked } }),
    onSuccess: (_result, { id, blocked }) => {
      setNotice(t(blocked ? 'endUsers.list.blockedDone' : 'endUsers.list.unblockedDone', { id }));
      void qc.invalidateQueries({ queryKey: ['end-users', orgId] });
    },
  });

  if (list.isError) return <ErrorState error={list.error} onRetry={() => void list.refetch()} />;
  if (!list.data) return <Loading />;
  const { items, total } = list.data;
  const date = (value: string | null) =>
    value
      ? formatDate(value, { calendar: settings.calendar, lang: settings.lang, time: true })
      : t('endUsers.list.never');

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title={t('endUsers.title')} subtitle={t('endUsers.subtitle')} />

      <ScopeLimitsCard
        orgId={orgId}
        canManage={canManage}
        only={[{ scope: 'end_user', id: '*', name: t('endUsers.everyone') }]}
        title={t('endUsers.defaults.title')}
        help={t('endUsers.defaults.help')}
        testId="end-user-defaults"
      />

      <Section title={t('endUsers.list.title')} help={t('endUsers.list.help')}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('endUsers.list.search')}</span>
            <input
              className={selectClass}
              dir="ltr"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOffset(0);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>{t('endUsers.list.filter')}</span>
            <select
              className={selectClass}
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as Status);
                setOffset(0);
              }}
            >
              <option value="all">{t('endUsers.list.all')}</option>
              <option value="active">{t('endUsers.list.active')}</option>
              <option value="blocked">{t('endUsers.list.blockedOnly')}</option>
            </select>
          </label>
        </div>
        {notice ? (
          <p role="status" className="rounded-lg bg-brand/10 px-3 py-2 text-sm">
            {notice}
          </p>
        ) : null}
        <FormError message={block.error ? errorMessage(block.error, t) : undefined} />
        {items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">{t('endUsers.list.empty')}</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="end-users">
              <thead>
                <tr className="border-y border-border bg-surface-2/60 text-xs">
                  <th className="px-5 py-2.5 text-start">{t('endUsers.list.id')}</th>
                  <th className="px-3 py-2.5 text-start">{t('endUsers.list.lastSeen')}</th>
                  <th className="px-3 py-2.5 text-end">{t('endUsers.list.requests')}</th>
                  <th className="px-3 py-2.5 text-end">{t('endUsers.list.cost')}</th>
                  <th className="px-3 py-2.5 text-start">{t('endUsers.list.status')}</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    data-testid={`end-user-${item.id}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-5 py-3 font-mono" dir="ltr">
                      <bdi>{item.id}</bdi>
                      {item.hasLimits ? (
                        <span className="ms-2 text-xs text-muted">
                          {t('endUsers.list.ownLimits')}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-fg-2">{date(item.lastSeenAt)}</td>
                    <td className="num px-3 py-3 text-end">{n(item.month.requests)}</td>
                    <td className="num px-3 py-3 text-end font-medium">
                      {usd(item.month.costUsd)}
                    </td>
                    <td className="px-3 py-3">
                      {item.blocked ? (
                        <span className="text-danger">{t('endUsers.list.blocked')}</span>
                      ) : (
                        t('endUsers.list.ok')
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          aria-expanded={open === item.id}
                          aria-label={`${t('endUsers.list.details')} ${item.id}`}
                          onClick={() => {
                            setOpen(open === item.id ? undefined : item.id);
                          }}
                        >
                          {open === item.id ? t('endUsers.list.close') : t('endUsers.list.details')}
                        </Button>
                        {canManage ? (
                          <Button
                            variant="ghost"
                            className={
                              item.blocked ? 'h-7 px-2 text-xs' : 'h-7 px-2 text-xs text-danger'
                            }
                            disabled={block.isPending}
                            aria-label={`${t(item.blocked ? 'endUsers.list.unblock' : 'endUsers.list.block')} ${item.id}`}
                            onClick={() => {
                              if (
                                item.blocked ||
                                window.confirm(t('endUsers.list.blockConfirm', { id: item.id }))
                              )
                                block.mutate({ id: item.id, blocked: !item.blocked });
                            }}
                          >
                            {t(item.blocked ? 'endUsers.list.unblock' : 'endUsers.list.block')}
                          </Button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE ? (
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted">
              {t('endUsers.list.range', {
                from: n(offset + 1),
                to: n(Math.min(offset + PAGE, total)),
                total: n(total),
              })}
            </span>
            <span className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => {
                  setOffset(Math.max(0, offset - PAGE));
                }}
              >
                {t('endUsers.list.previous')}
              </Button>
              <Button
                variant="outline"
                disabled={offset + PAGE >= total}
                onClick={() => {
                  setOffset(offset + PAGE);
                }}
              >
                {t('endUsers.list.next')}
              </Button>
            </span>
          </div>
        ) : null}
      </Section>

      {open ? (
        <>
          <Section title={`${t('endUsers.detail.usage')} · ${open}`}>
            {!detail.data ? (
              <Loading />
            ) : detail.data.days.length === 0 ? (
              <p className="text-sm text-muted">{t('endUsers.detail.none')}</p>
            ) : (
              <table className="w-full text-[13px]" data-testid="end-user-days">
                <thead>
                  <tr className="border-b border-border text-xs">
                    <th className="py-2 text-start">{t('endUsers.detail.day')}</th>
                    <th className="py-2 text-end">{t('endUsers.detail.requests')}</th>
                    <th className="py-2 text-end">{t('endUsers.detail.tokens')}</th>
                    <th className="py-2 text-end">{t('endUsers.detail.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.days.map((d) => (
                    <tr key={d.day} className="border-b border-border last:border-0">
                      <td className="py-2">
                        {formatDate(`${d.day}T00:00:00Z`, {
                          calendar: settings.calendar,
                          lang: settings.lang,
                        })}
                      </td>
                      <td className="num py-2 text-end">{n(d.requests)}</td>
                      <td className="num py-2 text-end">{n(d.tokens)}</td>
                      <td className="num py-2 text-end">{usd(d.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <ScopeLimitsCard
            orgId={orgId}
            canManage={canManage}
            only={[{ scope: 'end_user', id: open, name: open }]}
            title={t('endUsers.detail.limitsTitle', { id: open })}
            help={t('endUsers.detail.limitsHelp')}
            testId="end-user-limits"
          />
        </>
      ) : null}
    </section>
  );
}
