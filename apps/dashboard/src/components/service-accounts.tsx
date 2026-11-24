/**
 * Service accounts and their Management API tokens (card 23.6). Everyone who can see members sees
 * the list; creating, issuing and revoking needs `security:write`. A new token is shown once.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../lib/api';
import { formatDate } from '../lib/date';
import { parseIpList, type Preset, presetScopes } from '../lib/management-tokens';
import { errorMessage } from '../lib/errors';
import type { Role } from '../lib/session';
import { useSettings } from '../settings';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Field, FormError } from './ui/field';
import { Loading } from './ui/states';

export interface ManagementToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  allowedIps: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
}
export interface ServiceAccount {
  id: string;
  name: string;
  description: string | null;
  role: Role;
  permissions: string[];
  tokens: ManagementToken[];
}

const EXPIRIES = { d30: 30, d90: 90, d365: 365, never: null } as const;
type Expiry = keyof typeof EXPIRIES;
const ACCOUNT_ROLES: Role[] = ['ADMIN', 'MEMBER', 'VIEWER'];
const rank: Record<Role, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
const selectClass = 'h-10 rounded-lg border border-border bg-surface px-3 text-sm';

function TokenForm({
  account,
  base,
  onIssued,
}: {
  account: ServiceAccount;
  base: string;
  onIssued: (token: string) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<Preset>('read');
  const [custom, setCustom] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<Expiry>('d90');
  const [ips, setIps] = useState('');
  const issue = useMutation({
    mutationFn: () =>
      api<{ token: string }>(`${base}/service-accounts/${account.id}/tokens`, {
        method: 'POST',
        body: {
          name: name.trim(),
          scopes: presetScopes(preset, account.permissions, custom),
          expiresInDays: EXPIRIES[expiry],
          allowedIps: parseIpList(ips),
        },
      }),
    onSuccess: (result) => {
      onIssued(result.token);
      setName('');
      setIps('');
      void qc.invalidateQueries({ queryKey: ['service-accounts', base] });
    },
  });
  return (
    <form
      className="flex flex-col gap-2 border-t border-border pt-3"
      data-testid={`token-form-${account.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        issue.mutate();
      }}
    >
      <FormError message={issue.error ? errorMessage(issue.error, t) : undefined} />
      <div className="flex flex-wrap items-end gap-2">
        <Field
          name={`token-name-${account.id}`}
          label={t('s4.serviceAccounts.tokenName')}
          required
          maxLength={100}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <label className="flex flex-col gap-1 text-sm">
          {t('s4.serviceAccounts.access')}
          <select
            className={selectClass}
            value={preset}
            onChange={(event) => {
              setPreset(event.target.value as Preset);
            }}
          >
            {(['read', 'full', 'custom'] as const).map((p) => (
              <option key={p} value={p}>
                {t(`s4.serviceAccounts.presets.${p}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('s4.serviceAccounts.expiry')}
          <select
            className={selectClass}
            value={expiry}
            onChange={(event) => {
              setExpiry(event.target.value as Expiry);
            }}
          >
            {(Object.keys(EXPIRIES) as Expiry[]).map((key) => (
              <option key={key} value={key}>
                {t(`s4.serviceAccounts.expiries.${key}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {preset === 'custom' ? (
        <fieldset className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-3" dir="ltr">
          {account.permissions.map((permission) => (
            <label key={permission} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={custom.includes(permission)}
                onChange={(event) => {
                  setCustom((current) =>
                    event.target.checked
                      ? [...current, permission]
                      : current.filter((p) => p !== permission),
                  );
                }}
              />
              {permission}
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="flex flex-col gap-1 text-sm">
        {t('s4.serviceAccounts.allowedIps')}
        <textarea
          className="min-h-16 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
          dir="ltr"
          value={ips}
          onChange={(event) => {
            setIps(event.target.value);
          }}
        />
        <span className="text-xs text-muted">{t('s4.serviceAccounts.allowedIpsHelp')}</span>
      </label>
      <div>
        <Button type="submit" disabled={issue.isPending}>
          {t('s4.serviceAccounts.issue')}
        </Button>
      </div>
    </form>
  );
}

export function ServiceAccounts({
  base,
  canManage,
  role,
}: {
  base: string;
  canManage: boolean;
  role: Role | undefined;
}) {
  const { t } = useTranslation();
  const settings = useSettings();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [newRole, setNewRole] = useState<Role>('VIEWER');
  const [issued, setIssued] = useState<string>();
  // Expiry is judged against the time the list was opened; it refetches after every change.
  const [now] = useState(() => Date.now());
  const list = useQuery({
    queryKey: ['service-accounts', base],
    queryFn: () => api<ServiceAccount[]>(`${base}/service-accounts`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['service-accounts', base] });
  const create = useMutation({
    mutationFn: () =>
      api(`${base}/service-accounts`, {
        method: 'POST',
        body: { name: name.trim(), role: newRole },
      }),
    onSuccess: () => {
      setName('');
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`${base}/service-accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`${base}/management-tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
  });
  const failure = list.error ?? create.error ?? remove.error ?? revoke.error;
  const date = (iso: string) =>
    formatDate(iso, { calendar: settings.calendar, lang: settings.lang, time: true });
  const grantable = ACCOUNT_ROLES.filter((r) => role !== undefined && rank[r] <= rank[role]);

  function status(token: ManagementToken) {
    if (token.revokedAt) return t('s4.serviceAccounts.revoked');
    if (token.expiresAt && Date.parse(token.expiresAt) <= now)
      return t('s4.serviceAccounts.expired');
    return token.expiresAt
      ? t('s4.serviceAccounts.expires', { date: date(token.expiresAt) })
      : t('s4.serviceAccounts.neverExpires');
  }

  return (
    <Card data-testid="service-accounts" className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{t('s4.serviceAccounts.title')}</h2>
        <p className="mt-1 text-sm text-muted">{t('s4.serviceAccounts.help')}</p>
      </div>
      <FormError message={failure ? errorMessage(failure, t) : undefined} />
      {issued ? (
        <p className="text-sm text-warn" data-testid="management-token">
          {t('s4.serviceAccounts.shownOnce')}{' '}
          <code dir="ltr" className="break-all">
            {issued}
          </code>
        </p>
      ) : null}
      {list.isPending ? (
        <Loading />
      ) : !list.data?.length ? (
        <p className="text-sm text-muted">{t('s4.serviceAccounts.none')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.data.map((account) => (
            <li
              key={account.id}
              data-testid={`service-account-${account.id}`}
              className="flex flex-col gap-2 rounded border border-border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium" dir="auto">
                    {account.name}
                  </p>
                  <p className="text-xs text-muted">{t(`organization.roles.${account.role}`)}</p>
                </div>
                {canManage ? (
                  <Button
                    variant="outline"
                    className="h-7 px-2 text-xs text-danger"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          t('s4.serviceAccounts.removeConfirm', { name: account.name }),
                        )
                      )
                        remove.mutate(account.id);
                    }}
                  >
                    {t('s4.serviceAccounts.remove')}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs font-medium">{t('s4.serviceAccounts.tokens')}</p>
              {account.tokens.length === 0 ? (
                <p className="text-xs text-muted">{t('s4.serviceAccounts.noTokens')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {account.tokens.map((token) => (
                    <li
                      key={token.id}
                      data-testid={`token-${token.id}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded bg-surface-2 px-2 py-1 text-xs"
                    >
                      <span>
                        <span className="font-medium">{token.name}</span>{' '}
                        <code dir="ltr">{token.prefix}…</code>
                        {' · '}
                        {token.scopes.every((s) => s.endsWith(':read'))
                          ? t('s4.serviceAccounts.readOnly')
                          : t('s4.serviceAccounts.scopes', { count: token.scopes.length })}
                        {token.allowedIps.length > 0
                          ? ` · ${t('s4.serviceAccounts.ipRestricted', { count: token.allowedIps.length })}`
                          : ''}
                        {' · '}
                        {status(token)}
                        {' · '}
                        {token.lastUsedAt
                          ? t('s4.serviceAccounts.lastUsed', {
                              date: date(token.lastUsedAt),
                              ip: token.lastUsedIp ?? '?',
                            })
                          : t('s4.serviceAccounts.neverUsed')}
                      </span>
                      {canManage && !token.revokedAt ? (
                        <Button
                          variant="outline"
                          className="h-6 px-2 text-xs"
                          disabled={revoke.isPending}
                          onClick={() => {
                            revoke.mutate(token.id);
                          }}
                        >
                          {t('s4.serviceAccounts.revoke')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canManage ? <TokenForm account={account} base={base} onIssued={setIssued} /> : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Field
            name="service-account-name"
            label={t('s4.serviceAccounts.name')}
            required
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <label className="flex flex-col gap-1 text-sm">
            {t('s4.serviceAccounts.role')}
            <select
              className={selectClass}
              value={newRole}
              onChange={(event) => {
                setNewRole(event.target.value as Role);
              }}
            >
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {t(`organization.roles.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={create.isPending}>
            {t('s4.serviceAccounts.create')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
